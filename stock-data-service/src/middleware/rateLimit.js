const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../config/redis');
const config = require('../config/env');

const limiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'ratelimit:',
  }),
  windowMs: config.rateLimit.windowSeconds * 1000, // 秒转毫秒
  max: config.rateLimit.max,
  standardHeaders: true, // 返回 RateLimit-* 响应头
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests, please try again later.'
  },
  // 跳过健康检查接口
  skip: (req) => req.path === '/health',
});

module.exports = limiter;
