const cron = require("node-cron");
const redis = require("../config/redis");
const windhubApi = require("./windhubApi");
const notificationService = require("./notificationService");
const config = require("../config/env");
const logger = require("../utils/logger");
const REDIS_KEYS = require("../constants/redisKeys");
const {
  DATA_RETENTION_SECONDS,
  DATA_TTL_SECONDS,
  CACHE_TTL,
} = require("../constants/business");

class SyncScheduler {
  constructor() {
    this.task = null;
  }

  /**
   * 同步价格数据
   */
  async syncPrices() {
    try {
      logger.log("定时同步", "开始同步价格数据...");

      // 1. 调用Windhub API获取所有模型价格
      const marketData = await windhubApi.fetchMarketData();

      if (!marketData.stocks || marketData.stocks.length === 0) {
        logger.log("定时同步", "API返回数据为空");
        return;
      }

      // 2. 更新模型列表缓存
      const modelNames = marketData.stocks
        .map((s) => s.model_name)
        .filter(Boolean);
      if (modelNames.length > 0) {
        await redis.del(REDIS_KEYS.MODELS_ALL);
        await redis.sadd(REDIS_KEYS.MODELS_ALL, ...modelNames);
        await redis.expire(REDIS_KEYS.MODELS_ALL, CACHE_TTL.MODELS_LIST);
      }

      // 3. 批量存储价格数据
      const pipeline = redis.pipeline();
      for (const stock of marketData.stocks) {
        if (
          !stock.model_name ||
          stock.current_price === undefined ||
          !stock.last_update
        ) {
          continue;
        }

        const price = parseFloat(stock.current_price.toFixed(2));
        const timestamp = stock.last_update; // 秒级时间戳
        const key = REDIS_KEYS.PRICE(stock.model_name);
        const member = `${timestamp}:${price}`;

        // 先删除该时间戳的旧数据（防止同一时间戳有多条记录）
        pipeline.zremrangebyscore(key, timestamp, timestamp);

        // 添加新价格数据
        pipeline.zadd(key, timestamp, member);

        // 清理保留期之前的数据
        const cutoffTime = timestamp - DATA_RETENTION_SECONDS;
        pipeline.zremrangebyscore(key, "-inf", cutoffTime);

        // 设置TTL（兜底）
        pipeline.expire(key, DATA_TTL_SECONDS);
      }

      await pipeline.exec();

      // 成功后重置失败计数器
      await notificationService.resetFailureCount();

      logger.log(
        "定时同步",
        `同步完成，共 ${marketData.stocks.length} 个模型`,
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

    // 验证Cron表达式
    if (!cron.validate(cronExpression)) {
      throw new Error(`无效的Cron表达式: ${cronExpression}`);
    }

    // 服务启动时清理错误通知计数器
    try {
      await notificationService.resetFailureCount();
      logger.log("定时任务", "服务启动，已清理错误通知计数器");
    } catch (error) {
      logger.error("定时任务", "清理计数器失败:", error.message);
    }

    // 启动定时任务
    this.task = cron.schedule(cronExpression, () => {
      this.syncPrices();
    });

    logger.log("定时任务", `已启动，Cron表达式: ${cronExpression}`);

    // 立即执行一次
    this.syncPrices();
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.task) {
      this.task.stop();
      logger.log("定时任务", "已停止");
    }
  }
}

module.exports = new SyncScheduler();
