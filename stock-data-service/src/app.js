const express = require("express");
const compression = require("compression");
const path = require("path");
const config = require("./config/env");
const redis = require("./config/redis");
const rateLimiter = require("./middleware/rateLimit");
const apiRoutes = require("./routes/api");
const syncScheduler = require("./services/syncScheduler");
const logger = require("./utils/logger");

const app = express();

// Trust proxy 设置
const trustProxy = process.env.EXPRESS_TRUST_PROXY === "true";
app.set("trust proxy", trustProxy);

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS 支持
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// 响应压缩（dashboard 全量价格数据较大，gzip 后约 100~200KB）
app.use(compression());

// dashboard 静态托管：仅通过 /dashboard 前缀访问（页面位于 public/dashboard/），
// 挂在限流之前，页面资源加载不消耗 API 限流配额；未命中的路径 fallthrough 到限流与路由。
app.use("/dashboard", express.static(path.join(__dirname, "..", "public", "dashboard")));

// 应用限流中间件（/api/models、/api/prices/batch、/api/manual 与 /health 由 skip 跳过，不限流）
app.use(rateLimiter);

// 挂载路由
app.use("/api", apiRoutes);

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "接口不存在",
  });
});

// 错误处理
app.use((err, req, res, next) => {
  logger.error("服务器", "错误:", err);
  res.status(500).json({
    success: false,
    error: "服务器内部错误",
  });
});

// 启动服务
async function start() {
  try {
    // 打印环境变量
    logger.log("启动", "==========================================");
    logger.log("启动", "环境变量检查");
    logger.log("启动", "==========================================");
    logger.log("启动", `NODE_ENV: ${process.env.NODE_ENV}`);
    logger.log("启动", `REDIS_URL: ${process.env.REDIS_URL}`);
    logger.log(
      "启动",
      `ARK_GAME_COOKIE: ${process.env.ARK_GAME_COOKIE ? process.env.ARK_GAME_COOKIE.substring(0, 50) + "..." : "未设置"}`,
    );
    logger.log("启动", `ARK_GAME_BASE_URL: ${process.env.ARK_GAME_BASE_URL}`);
    logger.log("启动", `ARK_GAME_API_TIMEOUT: ${process.env.ARK_GAME_API_TIMEOUT}`);
    logger.log("启动", `ARK_GAME_API_RETRIES: ${process.env.ARK_GAME_API_RETRIES}`);
    logger.log("启动", `ARK_GAME_API_RETRY_DELAY: ${process.env.ARK_GAME_API_RETRY_DELAY}`);
    logger.log("启动", `SYNC_CRON: ${process.env.SYNC_CRON}`);
    logger.log(
      "启动",
      `RATE_LIMIT_WINDOW_SECONDS: ${process.env.RATE_LIMIT_WINDOW_SECONDS}`,
    );
    logger.log("启动", `RATE_LIMIT_MAX: ${process.env.RATE_LIMIT_MAX}`);
    logger.log("启动", `PORT: ${process.env.PORT}`);
    logger.log("启动", `EXPRESS_TRUST_PROXY: ${process.env.EXPRESS_TRUST_PROXY}`);
    logger.log("启动", "==========================================");
    logger.log("启动", "");

    // 检查 Redis 连接
    await redis.ping();
    logger.log("启动", "Redis 连接成功");

    // 启动 HTTP 服务
    app.listen(config.server.port, () => {
      logger.log("启动", `服务运行在端口 ${config.server.port}`);
      logger.log("启动", `环境：${config.server.env}`);
      logger.log(
        "启动",
        `限流配置:${config.rateLimit.max}次/${config.rateLimit.windowSeconds}秒`,
      );
    });

    // 启动定时任务
    await syncScheduler.start();

    // 启动时补漏一次（结果写入日志，独立于定时同步，追回停机期间遗漏的数据点）
    await syncScheduler.backfillOnce();
  } catch (error) {
    logger.error("启动", "启动失败:", error.message);
    process.exit(1);
  }
}

// 优雅关闭
process.on("SIGTERM", () => {
  logger.log("关闭", "收到 SIGTERM 信号");
  syncScheduler.stop();
  redis.quit();
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.log("关闭", "收到 SIGINT 信号");
  syncScheduler.stop();
  redis.quit();
  process.exit(0);
});

start();
