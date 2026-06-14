const Redis = require('ioredis');
const config = require('./env');

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
  console.log('[Redis] 已连接');
});

redis.on('error', (err) => {
  console.error('[Redis] 连接错误:', err.message);
});

redis.on('ready', () => {
  console.log('[Redis] 准备就绪');
});

redis.on('reconnecting', () => {
  console.log('[Redis] 正在重连...');
});

module.exports = redis;
