/**
 * Redis 键名常量
 * 统一管理所有 Redis 键的命名规则
 *
 * 主键策略：全部使用 stockId（数字），与用户脚本 ark-game-stock-monitor.user.js 一致
 * - 价格数据：price:{stockId}
 * - stockId 列表：stock_ids:all
 */

const REDIS_KEYS = {
  // 价格数据相关（主键 stockId）
  PRICE: (stockId) => `price:${stockId}`,
  STOCK_IDS_ALL: 'stock_ids:all',

  // 失败通知相关
  FAILURE_COUNT: 'ark_game:api:failure:count',
  LAST_ERROR: 'ark_game:api:failure:last_error',
  NOTIFICATION_COOLDOWN: 'ark_game:api:notification:cooldown',

  // 限流相关
  RATE_LIMIT_PREFIX: 'ratelimit:'
};

module.exports = REDIS_KEYS;
