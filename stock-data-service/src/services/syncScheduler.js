const { CronJob } = require("cron");
const redis = require("../config/redis");
const arkGameApi = require("./arkGameApi");
const priceStorage = require("./priceStorage");
const modelsService = require("./modelsService");
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
 * 价格数据只取自 ticks，复刻用户脚本 ark-game-stock-monitor.user.js 的 DataProcessor：
 * 1. ticks 按时间降序，以第一条（时间最大）的 createdAt 为基准
 * 2. 取基准往前 4 分半（270s）窗口内的 tick 作为同一批最新数据，时间戳统一为该基准
 * 3. 同一模型窗口内有多条时只保留最新一条（降序下遇到的第一条），价格取 tick 自身的 priceCents
 * 4. 不再用 stocks 的 stale 计数或 priceCents（stocks 可能漏返回模型）
 * stocks 仅用于预热 dashboard 模型列表缓存，不参与价格写入。
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

      // 顺带预热 dashboard 模型列表缓存（与同步同节奏，内部静默失败不影响主流程）。
      // stocks 只用于模型列表（名称/停滞标志/现价），不参与下面的价格写入。
      await modelsService.warmFromStocks(stocks);

      // 价格只取自 ticks：以时间最大的第一条为基准，4 分半窗口内视为同一批，
      // 时间戳统一为该基准，同模型只保留最新一条（降序下遇到的第一条）。
      const ticks = Array.isArray(marketData.ticks) ? marketData.ticks : [];
      const tickByStockId = {}; // stockId → { ts: 统一时间戳（秒）, price: 代币 }
      if (ticks.length > 0) {
        const maxTimestamp = this.toSeconds(ticks[0].createdAt);
        if (!Number.isNaN(maxTimestamp)) {
          const threshold = maxTimestamp - 270; // 4 分半
          for (const t of ticks) {
            const ts = this.toSeconds(t.createdAt);
            if (Number.isNaN(ts) || ts < threshold) break; // 降序，更早的都在窗口外
            const stockId = Number(t.stockId);
            if (!Number.isInteger(stockId)) continue;
            if (tickByStockId[stockId] !== undefined) continue; // 已保留最新一条
            if (t.priceCents === undefined || t.priceCents === null) continue;
            tickByStockId[stockId] = {
              ts: maxTimestamp,
              price: parseFloat((t.priceCents / 100).toFixed(2)), // 转代币
            };
          }
        }
      }

      const stockIds = Object.keys(tickByStockId).map(Number);
      if (stockIds.length === 0) {
        logger.log("定时同步", "ticks 窗口内无可用价格数据");
        return;
      }

      // 更新 stockId 列表缓存（取本轮窗口内有 tick 的 stockId）
      await redis.del(REDIS_KEYS.STOCK_IDS_ALL);
      await redis.sadd(REDIS_KEYS.STOCK_IDS_ALL, ...stockIds);
      await redis.expire(REDIS_KEYS.STOCK_IDS_ALL, CACHE_TTL.MODELS_LIST);

      // 批量存储价格数据（按 stockId）
      const pipeline = redis.pipeline();
      for (const stockId of stockIds) {
        const { ts, price } = tickByStockId[stockId];
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
      }

      await pipeline.exec();

      // 计数 > 0 表示上次成功清零之后发生过失败。本次响应的 ticks 含最近若干轮历史，
      // 据此补回失败轮次缺失的点（只补不覆盖）。读计数失败时返回 0，跳过补漏。
      // 补漏单独捕获：失败不能冒泡，否则会计入失败并挡住下面的计数清零。
      const hadFailures = (await notificationService.getFailureCount()) > 0;
      if (hadFailures) {
        try {
          await priceStorage.backfillAll(ticks);
        } catch (error) {
          logger.error("定时同步", "失败后补漏失败:", error.message);
        }
      }

      // 成功后重置失败计数器
      await notificationService.resetFailureCount();

      logger.log("定时同步", `同步完成，写入 ${stockIds.length} 条价格`);
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
   * 启动时补漏一次：拉取行情 ticks，全量核对并补写 Redis 缺失的历史数据点。
   * 结果由 priceStorage.backfillAll 内部写入日志。
   */
  async backfillOnce() {
    try {
      logger.log("补漏", "开始启动补漏...");
      const marketData = await arkGameApi.fetchMarketData();
      const ticks = Array.isArray(marketData.ticks) ? marketData.ticks : [];
      await priceStorage.backfillAll(ticks);
    } catch (error) {
      logger.error("补漏", "启动补漏失败:", error.message);
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
