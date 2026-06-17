require("dotenv").config();
const logger = require("../utils/logger");

// 必需的环境变量
const required = ["WINDHUB_USER_ID", "WINDHUB_COOKIE"];

for (const key of required) {
  if (!process.env[key]) {
    logger.error("环境配置", `缺少必需的环境变量 ${key}`);
    process.exit(1);
  }
}

module.exports = {
  // Windhub API配置
  windhub: {
    userId: process.env.WINDHUB_USER_ID,
    cookie: process.env.WINDHUB_COOKIE,
    baseUrl: process.env.WINDHUB_BASE_URL || "https://windhub.cc",
    timeout: parseInt(process.env.WINDHUB_API_TIMEOUT || "15000"), // 请求超时（毫秒）
    retries: parseInt(process.env.WINDHUB_API_RETRIES || "3"), // 重试次数
    retryDelay: parseInt(process.env.WINDHUB_API_RETRY_DELAY || "2000"), // 重试间隔（毫秒）
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
    channel: process.env.WINDHUB_API_FAILED_NOTIFICATION || "",
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
