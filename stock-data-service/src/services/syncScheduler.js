const cron = require('node-cron');
const redis = require('../config/redis');
const windhubApi = require('./windhubApi');
const config = require('../config/env');

/**
 * 格式化为东八区时间字符串
 * @returns {string} 格式: 2026-06-15 20:00:00
 */
function formatChinaTime() {
  const options = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  return new Date().toLocaleString('zh-CN', options).replace(/\//g, '-');
}

class SyncScheduler {
  constructor() {
    this.task = null;
  }

  /**
   * 同步价格数据
   */
  async syncPrices() {
    try {
      console.log(`[${formatChinaTime()}] 开始同步价格数据...`);

      // 1. 调用Windhub API获取所有模型价格
      const marketData = await windhubApi.fetchMarketData();

      if (!marketData.stocks || marketData.stocks.length === 0) {
        console.log(`[${formatChinaTime()}] API返回数据为空`);
        return;
      }

      // 2. 更新模型列表缓存
      const modelNames = marketData.stocks.map(s => s.model_name).filter(Boolean);
      if (modelNames.length > 0) {
        await redis.del('models:all');
        await redis.sadd('models:all', ...modelNames);
        await redis.expire('models:all', 3600); // 1小时
      }

      // 3. 批量存储价格数据
      const pipeline = redis.pipeline();
      for (const stock of marketData.stocks) {
        if (!stock.model_name || stock.current_price === undefined || !stock.last_update) {
          continue;
        }

        const price = parseFloat(stock.current_price.toFixed(2));
        const timestamp = stock.last_update; // 秒级时间戳
        const key = `price:${stock.model_name}`;
        const member = `${timestamp}:${price}`;

        // 先删除该时间戳的旧数据（防止同一时间戳有多条记录）
        pipeline.zremrangebyscore(key, timestamp, timestamp);

        // 添加新价格数据
        pipeline.zadd(key, timestamp, member);

        // 清理7天前数据
        const sevenDaysAgo = timestamp - (7 * 24 * 60 * 60);
        pipeline.zremrangebyscore(key, '-inf', sevenDaysAgo);

        // 设置TTL（8天兜底）
        pipeline.expire(key, 8 * 24 * 60 * 60);
      }

      await pipeline.exec();

      console.log(`[${formatChinaTime()}] 同步完成，共 ${marketData.stocks.length} 个模型`);
    } catch (error) {
      console.error(`[${formatChinaTime()}] 同步失败:`, error.message);
    }
  }

  /**
   * 启动定时任务
   */
  start() {
    const cronExpression = config.sync.cron;

    // 验证Cron表达式
    if (!cron.validate(cronExpression)) {
      throw new Error(`无效的Cron表达式: ${cronExpression}`);
    }

    // 启动定时任务
    this.task = cron.schedule(cronExpression, () => {
      this.syncPrices();
    });

    console.log(`[定时任务] 已启动，Cron表达式: ${cronExpression}`);

    // 立即执行一次
    this.syncPrices();
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.task) {
      this.task.stop();
      console.log('[定时任务] 已停止');
    }
  }
}

module.exports = new SyncScheduler();
