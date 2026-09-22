const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../config/redis');
const config = require('../config/env');
const REDIS_KEYS = require('../constants/redisKeys');

/**
 * dashboard 专用端点（app 级中间件中 req.path 为完整路径，含 /api 前缀），
 * 这些接口不再限流，供 dashboard 页面自由调用
 */
const DASHBOARD_PATHS = ['/api/models', '/api/prices/batch', '/api/manual'];

const limiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: REDIS_KEYS.RATE_LIMIT_PREFIX,
  }),
  windowMs: config.rateLimit.windowSeconds * 1000, // 秒转毫秒
  max: config.rateLimit.max,
  standardHeaders: true, // 返回 RateLimit-* 响应头
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests, please try again later.'
  },
  // 跳过健康检查接口与 dashboard 数据端点（/api/models、/api/prices/batch、/api/manual）
  skip: (req) => req.path === '/health' || DASHBOARD_PATHS.includes(req.path),
});

module.exports = limiter;
