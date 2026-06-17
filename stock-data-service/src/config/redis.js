const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

// 使用 URL 创建 Redis 客户端
const redis = new Redis(config.redis.url, {
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: null,
});

// 连接事件
redis.on('connect', () => {
  logger.info('Redis', '已连接');
});

redis.on('error', (err) => {
  logger.error('Redis', '连接错误:', err.message);
});

redis.on('ready', () => {
  logger.info('Redis', '准备就绪');
});

redis.on('reconnecting', () => {
  logger.info('Redis', '正在重连...');
});

module.exports = redis;
