const { CronJob } = require("cron");
const redis = require("../config/redis");
const arkGameApi = require("./arkGameApi");
const notificationService = require("./notificationService");
const config = require("../config/env");
const logger = require("../utils/logger");
const REDIS_KEYS = require("../constants/redisKeys");
const {
  DATA_RETENTION_SECONDS,
  DATA_TTL_SECONDS,
  CACHE_TTL,
} = require("../constants/business");

/**
 * 定时同步任务
 *
 * 数据获取逻辑严格复刻用户脚本 ark-game-stock-monitor.user.js 的 DataProcessor（行 594-651）：
 * 1. stale === false 过滤活跃模型，n = 活跃数量
 * 2. ticks.slice(0, n) —— API 每轮把活跃模型放最前，前 n 条与活跃模型一一对应（不重复、降序）
 * 3. 时间戳归一化：所有活跃模型共用本轮 maxTimestamp；若 ticks 跨度 > 5 分钟则过滤掉旧 tick
 * 4. 无匹配 tick 的活跃模型直接跳过，不写入价格数据（不用 Date.now() 兜底，避免污染历史曲线）
 */
class SyncScheduler {
  constructor() {
    this.job = null;
  }

  /**
   * 解析 ISO 时间戳为秒级时间戳
   * @param {string} iso - ISO 8601 时间字符串（ticks[].createdAt）
   * @returns {number} 秒级时间戳，解析失败返回 NaN
   */
  toSeconds(iso) {
    return Math.floor(Date.parse(iso) / 1000);
  }

  /**
   * 同步价格数据
   */
  async syncPrices() {
    try {
      logger.log("定时同步", "开始同步价格数据...");

      const marketData = await arkGameApi.fetchMarketData();
      const stocks = Array.isArray(marketData.stocks) ? marketData.stocks : [];

      if (stocks.length === 0) {
        logger.log("定时同步", "API 返回数据为空");
        return;
      }

      // 1. 过滤活跃模型（stale === false），n = 活跃数量
      //    stale=false 表示活跃/新鲜（本轮有 tick）；stale=true 表示陈旧（无 tick）
      const activeStocks = stocks.filter((s) => s.stale === false);
      const n = activeStocks.length;

      if (n === 0) {
        logger.log("定时同步", "无活跃模型（所有 stale=true）");
        return;
      }

      // 2. ticks 前 n 条与活跃模型按 stockId 一一对应（降序、不重复）
      const ticks = Array.isArray(marketData.ticks) ? marketData.ticks : [];
      const ticksSlice = ticks.slice(0, n);

      // 3. 时间戳归一化：统一为 maxTimestamp，过滤 5 分钟外的旧 tick
      const tickByStockId = {}; // stockId → 统一时间戳（秒）
      const activeTimestamps = ticksSlice
        .map((t) => this.toSeconds(t.createdAt))
        .filter((ts) => !Number.isNaN(ts));

      if (activeTimestamps.length > 0) {
        const maxTimestamp = Math.max(...activeTimestamps);
        const minTimestamp = Math.min(...activeTimestamps);
        // 跨度 > 5 分钟说明混入旧数据，只保留最近 5 分钟内的 tick
        const threshold =
          maxTimestamp - minTimestamp > 300 ? maxTimestamp - 300 : minTimestamp;
        const unifiedTimestamp = maxTimestamp; // 所有活跃模型共用此时间戳

        const filteredTicksSlice = ticksSlice.filter((t) => {
          const ts = this.toSeconds(t.createdAt);
          return !Number.isNaN(ts) && ts >= threshold;
        });
        for (const t of filteredTicksSlice) {
          if (tickByStockId[t.stockId] === undefined) {
            tickByStockId[t.stockId] = unifiedTimestamp;
          }
        }
      }

      // 4. 更新 stockId 列表缓存（取本轮有 tick 的活跃 stockId）
      const stockIds = Object.keys(tickByStockId)
        .map(Number)
        .filter((id) => Number.isInteger(id));
      if (stockIds.length > 0) {
        await redis.del(REDIS_KEYS.STOCK_IDS_ALL);
        await redis.sadd(REDIS_KEYS.STOCK_IDS_ALL, ...stockIds);
        await redis.expire(REDIS_KEYS.STOCK_IDS_ALL, CACHE_TTL.MODELS_LIST);
      }

      // 5. 批量存储价格数据（按 stockId，仅活跃且有匹配 tick 的）
      const pipeline = redis.pipeline();
      let writtenCount = 0;

      for (const stock of activeStocks) {
        const stockId = stock.id;
        const ts = tickByStockId[stockId];
        // 无匹配 tick → 跳过，不写入（与脚本一致，不兜底 Date.now()）
        if (ts === undefined) continue;
        if (stock.priceCents === undefined || stock.priceCents === null) continue;

        const price = parseFloat((stock.priceCents / 100).toFixed(2)); // 转代币
        const key = REDIS_KEYS.PRICE(stockId);
        const member = `${ts}:${price}`;

        // 删除同时间戳旧数据（脚本用「同时间戳已存在则跳过」，Redis 用先删后加等价实现）
        pipeline.zremrangebyscore(key, ts, ts);
        // 添加新价格数据
        pipeline.zadd(key, ts, member);
        // 清理保留期之前的数据
        const cutoffTime = ts - DATA_RETENTION_SECONDS;
        pipeline.zremrangebyscore(key, "-inf", cutoffTime);
        // 设置 TTL（兜底）
        pipeline.expire(key, DATA_TTL_SECONDS);

        writtenCount++;
      }

      await pipeline.exec();

      // 成功后重置失败计数器
      await notificationService.resetFailureCount();

      logger.log(
        "定时同步",
        `同步完成，活跃 ${n} 个，写入 ${writtenCount} 条价格`,
      );
    } catch (error) {
      logger.error("定时同步", "同步失败:", error.message);

      // 处理失败通知（不影响主流程）
      try {
        await notificationService.handleSyncFailure(error);
      } catch (notifyError) {
        logger.error(
          "定时同步",
          "通知服务异常:",
          notifyError.message,
        );
      }
    }
  }

  /**
   * 启动定时任务
   */
  async start() {
    const cronExpression = config.sync.cron;

    // 服务启动时清理错误通知计数器
    try {
      await notificationService.resetFailureCount();
      logger.log("定时任务", "服务启动，已清理错误通知计数器");
    } catch (error) {
      logger.error("定时任务", "清理计数器失败:", error.message);
    }

    // 启动定时任务（cron 库构造时即校验表达式，非法直接抛错）
    // 注意：不立即 start()，改为「先手动调用一次再启动」避免重复执行
    this.job = new CronJob(cronExpression, () => {
      this.syncPrices();
    });

    logger.log("定时任务", `已启动，Cron表达式: ${cronExpression}`);

    // 立即执行一次
    await this.syncPrices();

    this.job.start();
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.job) {
      this.job.stop();
      logger.log("定时任务", "已停止");
    }
  }
}

module.exports = new SyncScheduler();
