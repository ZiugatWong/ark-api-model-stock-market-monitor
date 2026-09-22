/**
 * Redis 键名常量
 * 统一管理所有 Redis 键的命名规则
 *
 * 主键策略：全部使用 stockId（数字），与用户脚本 ark-game-stock-monitor.user.js 一致
 * - 价格数据：price:{stockId}
 * - stockId 列表：stock_ids:all
 * - dashboard 模型列表：stock_models:all / stock_models:lastgood
 */

const REDIS_KEYS = {
  // 价格数据相关（主键 stockId）
  PRICE: (stockId) => `price:${stockId}`,
  STOCK_IDS_ALL: 'stock_ids:all',

  // dashboard 模型列表缓存
  MODELS_ALL: 'stock_models:all',            // 主缓存，TTL 5 分钟
  MODELS_LASTGOOD: 'stock_models:lastgood',  // 上游故障兜底缓存，TTL 24 小时

  // 失败通知相关
  FAILURE_COUNT: 'ark_game:api:failure:count',
  LAST_ERROR: 'ark_game:api:failure:last_error',
  NOTIFICATION_COOLDOWN: 'ark_game:api:notification:cooldown',

  // 限流相关（dashboard 端点已不限流，无需独立前缀）
  RATE_LIMIT_PREFIX: 'ratelimit:'
};

module.exports = REDIS_KEYS;
