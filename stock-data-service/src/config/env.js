require("dotenv").config();

// 必需的环境变量
const required = ["WINDHUB_USER_ID", "WINDHUB_COOKIE"];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`错误: 缺少必需的环境变量 ${key}`);
    process.exit(1);
  }
}

module.exports = {
  // Windhub API配置
  windhub: {
    userId: process.env.WINDHUB_USER_ID,
    cookie: process.env.WINDHUB_COOKIE,
    baseUrl: process.env.WINDHUB_BASE_URL || "https://windhub.cc",
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
    console.warn(
      "[警告] 通知配置不完整：缺少 Telegram 凭证，通知功能将无法使用"
    );
  }
}
