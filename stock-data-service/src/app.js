const express = require('express');
const config = require('./config/env');
const redis = require('./config/redis');
const rateLimiter = require('./middleware/rateLimit');
const apiRoutes = require('./routes/api');
const syncScheduler = require('./services/syncScheduler');

const app = express();

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS支持
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 应用限流中间件
app.use(rateLimiter);

// 挂载路由
app.use('/api', apiRoutes);

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在'
  });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('[服务器错误]:', err);
  res.status(500).json({
    success: false,
    error: '服务器内部错误'
  });
});

// 启动服务
async function start() {
  try {
    // 打印环境变量
    console.log('==========================================');
    console.log('[启动] 环境变量检查');
    console.log('==========================================');
    console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
    console.log(`REDIS_URL: ${process.env.REDIS_URL}`);
    console.log(`WINDHUB_USER_ID: ${process.env.WINDHUB_USER_ID}`);
    console.log(`WINDHUB_COOKIE: ${process.env.WINDHUB_COOKIE ? process.env.WINDHUB_COOKIE.substring(0, 50) + '...' : '未设置'}`);
    console.log(`WINDHUB_BASE_URL: ${process.env.WINDHUB_BASE_URL}`);
    console.log(`SYNC_CRON: ${process.env.SYNC_CRON}`);
    console.log(`RATE_LIMIT_WINDOW_SECONDS: ${process.env.RATE_LIMIT_WINDOW_SECONDS}`);
    console.log(`RATE_LIMIT_MAX: ${process.env.RATE_LIMIT_MAX}`);
    console.log(`PORT: ${process.env.PORT}`);
    console.log('==========================================');
    console.log('');

    // 检查Redis连接
    await redis.ping();
    console.log('[启动] Redis连接成功');

    // 启动定时任务
    syncScheduler.start();

    // 启动HTTP服务
    app.listen(config.server.port, () => {
      console.log(`[启动] 服务运行在端口 ${config.server.port}`);
      console.log(`[启动] 环境: ${config.server.env}`);
      console.log(`[启动] 限流配置: ${config.rateLimit.max}次/${config.rateLimit.windowSeconds}秒`);
    });
  } catch (error) {
    console.error('[启动失败]:', error.message);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[关闭] 收到SIGTERM信号');
  syncScheduler.stop();
  redis.quit();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[关闭] 收到SIGINT信号');
  syncScheduler.stop();
  redis.quit();
  process.exit(0);
});

start();
