const redis = require("../config/redis");
const arkGameApi = require("./arkGameApi");
const REDIS_KEYS = require("../constants/redisKeys");
const { CACHE_TTL } = require("../constants/business");
const logger = require("../utils/logger");

/**
 * dashboard 模型列表服务
 *
 * 职责：模型列表（id/名称/停滞标志/现价）的缓存读写、上游拉取、兜底降级。
 * 两级缓存策略：
 * - stock_models:all 主缓存（TTL 5 分钟，与同步周期一致），命中直接返回
 * - 未命中 → 拉上游归一化并回写两级缓存
 * - 上游失败 → stock_models:lastgood 兜底缓存（TTL 24 小时）返回旧数据（附 staleCache）
 * - 兜底也缺失 → 抛错（由 asyncHandler 捕获返回 500）
 * 写入为增量合并：接口偶发漏返回模型时，保留缓存里上一轮的记录，只增改不删除。
 */
class ModelsService {
  /**
   * 获取模型列表（缓存优先）
   * @returns {Promise<Object>} { models:[{id,name,stale,price}], count, cachedAt?, staleCache? }
   */
  async getModels() {
    // 1. 主缓存命中直接返回
    const cached = await redis.get(REDIS_KEYS.MODELS_ALL);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (error) {
        logger.warn("模型列表", "主缓存数据解析失败，重新拉取:", error.message);
      }
    }

    // 2. 未命中 → 拉上游
    try {
      return await this.fetchAndCache();
    } catch (error) {
      // 3. 上游失败 → 读兜底缓存
      const lastgood = await redis.get(REDIS_KEYS.MODELS_LASTGOOD);
      if (lastgood) {
        try {
          const payload = JSON.parse(lastgood);
          logger.warn(
            "模型列表",
            `上游拉取失败（${error.message}），返回兜底缓存`,
          );
          return { ...payload, staleCache: true };
        } catch (parseError) {
          logger.warn(
            "模型列表",
            "兜底缓存数据解析失败:",
            parseError.message,
          );
        }
      }
      // 4. 兜底也缺失 → 抛错
      throw error;
    }
  }

  /**
   * 拉取上游行情并归一化、写入两级缓存
   * @returns {Promise<Object>} { models, count, cachedAt }
   */
  async fetchAndCache() {
    const marketData = await arkGameApi.fetchMarketData(); // 复用含重试的封装
    const stocks = Array.isArray(marketData.stocks) ? marketData.stocks : [];
    return this.warmFromStocks(stocks, { throwIfEmpty: true });
  }

  /**
   * 从 stocks 数组预热缓存（供定时同步调用，与同步同节奏刷新）
   * 增量合并：以缓存中已有模型为底，本次返回的同 id 模型覆盖其字段，
   * 本次未返回的模型保留原记录（接口偶发漏返回模型时不丢），不做删除。
   * @param {Array} stocks - 上游 /api/stock 的 stocks 数组
   * @param {Object} [opts]
   * @param {boolean} [opts.throwIfEmpty] - stocks 为空时抛错（fetchAndCache 场景）
   * @returns {Promise<Object|null>} 合并后的 payload，预热场景无数据时返回 null
   */
  async warmFromStocks(stocks, { throwIfEmpty = false } = {}) {
    const incoming = this._normalizeStocks(stocks);
    if (incoming.length === 0) {
      if (throwIfEmpty) {
        throw new Error("上游行情 stocks 数据为空或格式无效");
      }
      return null; // 预热场景静默跳过
    }

    // 以上次快照为底合并。读兜底缓存而非主缓存：主缓存 TTL 仅 5 分钟，
    // 过期后就读不到上一轮记录了，而兜底缓存保留 24 小时。
    const cached = await this._readPayload(REDIS_KEYS.MODELS_LASTGOOD);
    const merged = new Map((cached?.models || []).map((m) => [m.id, m]));
    for (const model of incoming) merged.set(model.id, model);

    const payload = {
      models: Array.from(merged.values()),
      count: merged.size,
      cachedAt: Math.floor(Date.now() / 1000),
    };
    const serialized = JSON.stringify(payload);

    // 主缓存 5 分钟 + 兜底缓存 24 小时，一次 pipeline 写入
    const pipeline = redis.pipeline();
    pipeline.setex(
      REDIS_KEYS.MODELS_ALL,
      CACHE_TTL.MODELS_DASHBOARD,
      serialized,
    );
    pipeline.setex(
      REDIS_KEYS.MODELS_LASTGOOD,
      CACHE_TTL.MODELS_LASTGOOD,
      serialized,
    );
    await pipeline.exec();

    return payload;
  }

  /**
   * 读取并解析缓存中的模型列表 payload
   * @param {string} key - Redis 键
   * @returns {Promise<Object|null>} 解析失败或不存在时返回 null
   */
  async _readPayload(key) {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      if (!payload || !Array.isArray(payload.models)) return null;
      return payload;
    } catch (error) {
      logger.warn("模型列表", "缓存数据解析失败，忽略旧数据:", error.message);
      return null;
    }
  }

  /**
   * stocks 数组 → models 归一化（过滤无效项）
   * @param {Array} stocks - 上游 stocks 数组
   * @returns {Array<{id,name,stale,price}>}
   */
  _normalizeStocks(stocks) {
    if (!Array.isArray(stocks)) return [];
    return stocks
      .map((s) => ({
        id: s.id,
        name: s.modelName,
        stale: s.stale === true,
        price:
          s.priceCents === undefined || s.priceCents === null
            ? null
            : parseFloat((s.priceCents / 100).toFixed(2)),
      }))
      .filter(
        (m) => Number.isInteger(m.id) && typeof m.name === "string" && m.name,
      );
  }
}

module.exports = new ModelsService();
