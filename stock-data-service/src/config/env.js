require("dotenv").config();
const logger = require("../utils/logger");

// 必需的环境变量：新接口仅需 Cookie（不再需要 USER_ID）
const required = ["ARK_GAME_COOKIE"];

for (const key of required) {
  if (!process.env[key]) {
    logger.error("环境配置", `缺少必需的环境变量 ${key}`);
    process.exit(1);
  }
}

module.exports = {
  // Ark Game API 配置（game.arkengine.me）
  arkGame: {
    cookie: process.env.ARK_GAME_COOKIE,
    baseUrl: process.env.ARK_GAME_BASE_URL || "https://game.arkengine.me",
    timeout: parseInt(process.env.ARK_GAME_API_TIMEOUT || "15000"), // 请求超时（毫秒）
    retries: parseInt(process.env.ARK_GAME_API_RETRIES || "3"), // 重试次数
    retryDelay: parseInt(process.env.ARK_GAME_API_RETRY_DELAY || "2000"), // 重试间隔（毫秒）
  },

  // 定时任务配置
  sync: {
    cron: process.env.SYNC_CRON || "*/5 * * * *",
  },

  // Redis配置
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },

  // 限流配置
  rateLimit: {
    windowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || "60"),
    max: parseInt(process.env.RATE_LIMIT_MAX || "3"),
  },

  // 服务配置
  server: {
    port: parseInt(process.env.PORT || "3210"),
    env: process.env.NODE_ENV || "development",
  },

  // 通知配置
  notification: {
    channel: process.env.ARK_GAME_API_FAILED_NOTIFICATION || "",
    failureThreshold: 3,
    cooldownSeconds: 1800,
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || "",
    },
  },
};

// 通知配置完整性检查
if (module.exports.notification.channel === "telegram") {
  if (
    !module.exports.notification.telegram.botToken ||
    !module.exports.notification.telegram.chatId
  ) {
    logger.warn(
      "环境配置",
      "通知配置不完整：缺少 Telegram 凭证，通知功能将无法使用",
    );
  }
}
