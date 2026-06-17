/**
 * Redis 键名常量
 * 统一管理所有 Redis 键的命名规则
 */

const REDIS_KEYS = {
  // 价格数据相关
  PRICE: (modelName) => `price:${modelName}`,
  MODELS_ALL: 'models:all',

  // 失败通知相关
  FAILURE_COUNT: 'windhub:api:failure:count',
  LAST_ERROR: 'windhub:api:failure:last_error',
  NOTIFICATION_COOLDOWN: 'windhub:api:notification:cooldown',

  // 限流相关
  RATE_LIMIT_PREFIX: 'ratelimit:'
};

module.exports = REDIS_KEYS;
