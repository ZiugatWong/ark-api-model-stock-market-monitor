const redis = require("../config/redis");
const REDIS_KEYS = require("../constants/redisKeys");
const logger = require("../utils/logger");
const {
  DATA_RETENTION_DAYS,
  DATA_RETENTION_SECONDS,
  DATA_TTL_SECONDS,
} = require("../constants/business");

class PriceStorage {
  /**
   * 批量查询多个模型的价格数据（主键 stockId）
   * @param {number[]} stockIds - stockId 列表
   * @param {number} days - 查询天数，默认使用配置的保留天数
   * @returns {Promise<Object>} 格式: {stockId: [{timestamp, price}, ...]}
   */
  async getBatchPrices(stockIds, days = DATA_RETENTION_DAYS) {
    if (!stockIds || stockIds.length === 0) {
      return {};
    }

    const startTime = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

    // 使用 Pipeline 批量查询
    const pipeline = redis.pipeline();
    stockIds.forEach((id) => {
      pipeline.zrangebyscore(REDIS_KEYS.PRICE(id), startTime, "+inf");
    });

    const results = await pipeline.exec();

    // 组装返回数据（key 为 stockId）
    return stockIds.reduce((acc, id, idx) => {
      const members = results[idx][1] || [];
      acc[id] = members.map((member) => {
        const [timestamp, price] = member.split(":");
        return {
          timestamp: parseInt(timestamp),
          price: parseFloat(price),
        };
      });
      return acc;
    }, {});
  }

  /**
   * 补漏全量检查所有模型：从 API 的 ticks 还原出同一批数据，再做归一化后核对 Redis 缺失项并补充。
   *
   * 必须复刻定时同步（syncScheduler.syncPrices）的归一化规则：
   * - 分批：ticks 中「模型连续不重复」划为一批，出现已在本批内的模型 → 下一批
   * - 每批内过滤与批内最大时间戳差超 5 分钟（300s）的旧数据，剩余时间戳统一为该批最大时间戳
   * - 只按时间戳判缺、补缺失点，不覆盖已有不同价格的同时间戳数据
   * @param {Array} ticks - GET /api/stock 返回的 ticks 数组
   * @returns {Promise<Object>} { modelCount, perModel }（perModel: { [stockId]: 补入数量 }，仅含实际补入的模型）
   */
  async backfillAll(ticks) {
    const perModel = new Map(); // stockId -> Map(ts -> price)
    for (const batch of this._groupBatches(Array.isArray(ticks) ? ticks : [])) {
      for (const pt of this._normalizeBatch(batch)) {
        if (!perModel.has(pt.stockId)) perModel.set(pt.stockId, new Map());
        const m = perModel.get(pt.stockId);
        if (!m.has(pt.ts)) m.set(pt.ts, pt.price); // ts 去重
      }
    }

    if (perModel.size === 0) {
      logger.log("补漏", "ticks 无可用数据，跳过");
      return { modelCount: 0, perModel: {} };
    }

    const keys = Array.from(perModel.keys());

    // 1. 一条读 pipeline 取所有模型的现有时间戳集合
    const readPipe = redis.pipeline();
    keys.forEach((id) =>
      readPipe.zrangebyscore(REDIS_KEYS.PRICE(id), 0, "+inf"),
    );
    const readResults = await readPipe.exec();

    // 2. 计算缺失并批量写入
    const stats = {}; // stockId -> 补入数量
    const writePipe = redis.pipeline();
    let added = 0;

    keys.forEach((id, idx) => {
      const cand = perModel.get(id);
      const members = (readResults[idx] && readResults[idx][1]) || [];
      const existingTs = new Set(
        members.map((m) => parseInt(String(m).split(":")[0], 10)),
      );
      const key = REDIS_KEYS.PRICE(id);

      let missing = 0;
      for (const [ts, price] of cand) {
        if (existingTs.has(ts)) continue; // 已存在，跳过
        missing++;
        const member = `${ts}:${price}`;
        // 沿用同步的防重写法（先删同时间戳再加，等价「同时间戳已存在不上传」）
        writePipe.zremrangebyscore(key, ts, ts);
        writePipe.zadd(key, ts, member);
      }
      if (missing > 0) writePipe.expire(key, DATA_TTL_SECONDS); // TTL 兜底

      if (missing > 0) stats[id] = missing;
      added += missing;
    });

    await writePipe.exec();

    // 3. 保证补漏的模型能被 /api/prices/batch、/api/stock-ids 查到
    if (keys.length) await redis.sadd(REDIS_KEYS.STOCK_IDS_ALL, ...keys);

    // 4. 日志（只输出模型数量与各模型补漏数量）
    const detail = Object.entries(stats)
      .map(([id, n]) => `${id}:${n}`)
      .join(", ");
    logger.log(
      "补漏",
      `已完成，补漏模型 ${keys.length} 个，共补入 ${added} 条价格数据${
        detail ? `，各模型补入数量为：{${detail}}` : ""
      }`,
    );

    return { modelCount: keys.length, perModel: stats };
  }

  /**
   * 分批：ticks 中「模型连续不重复」划为一批，出现已在本批内的模型 → 开启下一批
   * @param {Array} ticks
   * @returns {Array<Array>} 批次数组
   */
  _groupBatches(ticks) {
    const batches = [];
    let cur = [];
    let seen = new Set();
    for (const t of ticks) {
      const id = Number(t.stockId);
      if (seen.has(id)) {
        batches.push(cur);
        cur = [];
        seen = new Set();
      }
      cur.push(t);
      seen.add(id);
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /**
   * 归一化单批：过滤与批内最大时间戳差超 5 分钟（300s）的旧数据，剩余时间戳统一为批内最大时间戳。
   * price 沿用每个 tick 自带的 priceCents。
   * @param {Array} batch
   * @returns {Array<{stockId,ts,price}>}
   */
  _normalizeBatch(batch) {
    const now = Math.floor(Date.now() / 1000);
    const pts = batch
      .map((t) => ({
        stockId: Number(t.stockId),
        ts: Math.floor(Date.parse(t.createdAt) / 1000),
        price: parseFloat((t.priceCents / 100).toFixed(2)),
      }))
      .filter(
        (p) =>
          Number.isInteger(p.stockId) &&
          !Number.isNaN(p.ts) &&
          !Number.isNaN(p.price) &&
          p.ts > now - DATA_RETENTION_SECONDS, // 只补保留期内的数据
      );
    if (pts.length === 0) return [];

    const tsList = pts.map((p) => p.ts);
    const maxT = Math.max(...tsList);
    const minT = Math.min(...tsList);
    const threshold = maxT - minT > 300 ? maxT - 300 : minT;

    return pts
      .filter((p) => p.ts >= threshold)
      .map((p) => ({ stockId: p.stockId, ts: maxT, price: p.price }));
  }

  /**
   * 获取所有可用 stockId 列表
   * @returns {Promise<number[]>} stockId 列表（升序）
   */
  async getAllStockIds() {
    const ids = await redis.smembers(REDIS_KEYS.STOCK_IDS_ALL);
    return ids
      .map((id) => parseInt(id))
      .filter((id) => Number.isInteger(id))
      .sort((a, b) => a - b);
  }
}

module.exports = new PriceStorage();
