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
   * 补漏全量检查所有模型：从 API 的 ticks 还原出各轮数据，核对 Redis 缺失的时间戳并补充。
   *
   * 分轮规则与定时同步（syncScheduler.syncPrices）、用户脚本一致：
   * ticks 按时间降序，以第一条为基准取往前 4 分半（270s）窗口为一轮，时间戳统一为该轮基准，
   * 同模型只保留最新一条、价格取 tick 自身的 priceCents；然后从窗口之后继续，逐轮切分。
   * 只按时间戳判缺、补缺失点，不覆盖已有不同价格的同时间戳数据。
   * @param {Array} ticks - GET /api/stock 返回的 ticks 数组（时间降序）
   * @returns {Promise<Object>} { modelCount, perModel }（perModel: { [stockId]: 补入数量 }，仅含实际补入的模型）
   */
  async backfillAll(ticks) {
    const perModel = new Map(); // stockId -> Map(ts -> price)
    for (const round of this._splitRounds(Array.isArray(ticks) ? ticks : [])) {
      for (const pt of round) {
        if (!perModel.has(pt.stockId)) perModel.set(pt.stockId, new Map());
        const m = perModel.get(pt.stockId);
        if (!m.has(pt.ts)) m.set(pt.ts, pt.price); // ts 去重，保留先遇到的（较新的一轮）
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
   * 按轮切分 ticks：ticks 按时间降序，每轮以当前剩余第一条为基准，
   * 取其往前 4 分半（270s）窗口内的 tick，时间戳统一为该基准，同模型只保留最新一条，
   * 价格取 tick 自身的 priceCents。与定时同步、用户脚本的取数规则一致。
   * @param {Array} ticks - 时间降序的 ticks
   * @returns {Array<Array<{stockId,ts,price}>>} 各轮的数据点
   */
  _splitRounds(ticks) {
    const now = Math.floor(Date.now() / 1000);
    const rounds = [];
    let i = 0;
    while (i < ticks.length) {
      const maxT = Math.floor(Date.parse(ticks[i].createdAt) / 1000);
      if (Number.isNaN(maxT)) {
        i++;
        continue;
      }
      // 基准已超出保留期，更早的 tick 也都超出，无需继续
      if (maxT <= now - DATA_RETENTION_SECONDS) break;

      const threshold = maxT - 270; // 4 分半
      const seen = new Set();
      const round = [];
      while (i < ticks.length) {
        const t = ticks[i];
        const ts = Math.floor(Date.parse(t.createdAt) / 1000);
        if (Number.isNaN(ts) || ts < threshold) break; // 降序，本轮窗口结束
        i++;
        const stockId = Number(t.stockId);
        if (!Number.isInteger(stockId) || seen.has(stockId)) continue;
        if (t.priceCents === undefined || t.priceCents === null) continue;
        const price = parseFloat((t.priceCents / 100).toFixed(2));
        if (Number.isNaN(price)) continue;
        seen.add(stockId);
        round.push({ stockId, ts: maxT, price });
      }
      if (round.length) rounds.push(round);
    }
    return rounds;
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
