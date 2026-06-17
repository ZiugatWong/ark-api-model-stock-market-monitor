const axios = require('axios');
const redis = require('../config/redis');
const config = require('../config/env');
const { formatChinaTime } = require('../utils/timeUtils');
const REDIS_KEYS = require('../constants/redisKeys');
const { CACHE_TTL } = require('../constants/business');

/**
 * 通知服务
 * 负责管理 WindHub API 调用失败的通知功能
 */
class NotificationService {
  constructor() {
    this.channel = config.notification.channel;
    this.failureThreshold = config.notification.failureThreshold;
    this.cooldownSeconds = config.notification.cooldownSeconds;
    this.telegram = config.notification.telegram;
  }

  /**
   * Redis Key 常量
   */
  static KEYS = {
    FAILURE_COUNT: REDIS_KEYS.FAILURE_COUNT,
    LAST_ERROR: REDIS_KEYS.LAST_ERROR,
    COOLDOWN: REDIS_KEYS.NOTIFICATION_COOLDOWN
  };

  /**
   * 递增失败计数器
   * @param {string} errorMessage - 错误消息
   * @returns {Promise<number>} 当前失败次数
   */
  async incrementFailureCount(errorMessage) {
    try {
      // 递增计数器
      const count = await redis.incr(NotificationService.KEYS.FAILURE_COUNT);

      // 设置过期时间
      await redis.expire(NotificationService.KEYS.FAILURE_COUNT, CACHE_TTL.FAILURE_COUNT);

      // 保存最后一次错误详情
      const errorDetails = {
        message: errorMessage,
        timestamp: Date.now(),
        count: count
      };

      await redis.set(
        NotificationService.KEYS.LAST_ERROR,
        JSON.stringify(errorDetails),
        'EX',
        CACHE_TTL.ERROR_DETAILS
      );

      return count;
    } catch (error) {
      console.error(`[通知服务] Redis 操作失败:`, error.message);
      return 0;
    }
  }

  /**
   * 重置失败计数器
   * @returns {Promise<void>}
   */
  async resetFailureCount() {
    try {
      await redis.del(NotificationService.KEYS.FAILURE_COUNT);
      await redis.del(NotificationService.KEYS.LAST_ERROR);
    } catch (error) {
      console.error(`[通知服务] 重置计数器失败:`, error.message);
    }
  }

  /**
   * 获取当前失败次数
   * @returns {Promise<number>}
   */
  async getFailureCount() {
    try {
      const count = await redis.get(NotificationService.KEYS.FAILURE_COUNT);
      return count ? parseInt(count) : 0;
    } catch (error) {
      console.error(`[通知服务] 获取计数器失败:`, error.message);
      return 0;
    }
  }

  /**
   * 获取最后一次错误详情
   * @returns {Promise<Object|null>}
   */
  async getLastError() {
    try {
      const data = await redis.get(NotificationService.KEYS.LAST_ERROR);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`[通知服务] 获取错误详情失败:`, error.message);
      return null;
    }
  }

  /**
   * 检查是否在冷却期内
   * @returns {Promise<boolean>}
   */
  async isInCooldown() {
    try {
      const exists = await redis.exists(NotificationService.KEYS.COOLDOWN);
      return exists === 1;
    } catch (error) {
      console.error(`[通知服务] 检查冷却期失败:`, error.message);
      return false;
    }
  }

  /**
   * 设置通知冷却期
   * @param {number} seconds - 冷却期秒数（默认 30 分钟）
   * @returns {Promise<void>}
   */
  async setCooldown(seconds = this.cooldownSeconds) {
    try {
      await redis.set(NotificationService.KEYS.COOLDOWN, '1', 'EX', seconds);
    } catch (error) {
      console.error(`[通知服务] 设置冷却期失败:`, error.message);
    }
  }

  /**
   * 格式化 Telegram 消息
   * @param {Object} errorDetails - 错误详情
   * @returns {string} 格式化的消息
   */
  formatTelegramMessage(errorDetails) {
    const timestamp = new Date(errorDetails.timestamp).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(/\//g, '-');

    return `⚠️ WindHub API 连续失败告警

失败次数: ${errorDetails.count} 次
最后失败时间: ${timestamp}
失败原因: ${errorDetails.message}

请检查 WINDHUB_COOKIE 是否过期。`;
  }

  /**
   * 发送 Telegram 通知
   * @param {string} message - 消息内容
   * @returns {Promise<boolean>} 是否发送成功
   */
  async sendTelegram(message) {
    const { botToken, chatId } = this.telegram;

    if (!botToken || !chatId) {
      console.warn(`[通知服务] Telegram 配置不完整，跳过发送`);
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const response = await axios.post(url, {
        chat_id: chatId,
        text: message
      }, {
        timeout: 10000  // 10 秒超时
      });

      if (response.data.ok) {
        console.log(`[${formatChinaTime()}] Telegram 通知发送成功`);
        return true;
      } else {
        console.error(`[通知服务] Telegram API 返回失败:`, response.data);
        return false;
      }
    } catch (error) {
      console.error(`[通知服务] Telegram 发送失败:`, error.message);
      if (error.response) {
        console.error(`[通知服务] 响应状态:`, error.response.status);
        console.error(`[通知服务] 响应数据:`, JSON.stringify(error.response.data));
      }
      return false;
    }
  }

  /**
   * 发送失败通知
   * @param {Object} errorDetails - 错误详情
   * @returns {Promise<Object>} 发送结果
   */
  async sendFailureNotification(errorDetails) {
    if (!this.channel) {
      return { success: false, skipped: true, reason: 'No notification channel configured' };
    }

    switch (this.channel) {
      case 'telegram':
        const message = this.formatTelegramMessage(errorDetails);
        const success = await this.sendTelegram(message);
        return { success, channel: 'telegram' };

      default:
        console.warn(`[通知服务] 未知通知渠道: ${this.channel}`);
        return { success: false, error: 'Unknown channel' };
    }
  }

  /**
   * 处理同步失败
   * 主入口：管理失败计数、检查阈值、发送通知
   * @param {Error} error - 错误对象
   * @returns {Promise<void>}
   */
  async handleSyncFailure(error) {
    try {
      // 1. 递增失败计数器
      const failureCount = await this.incrementFailureCount(error.message);

      console.log(`[${formatChinaTime()}] API 失败计数: ${failureCount}/${this.failureThreshold}`);

      // 2. 检查是否达到阈值
      if (failureCount < this.failureThreshold) {
        return;
      }

      // 3. 检查是否在冷却期内
      const inCooldown = await this.isInCooldown();
      if (inCooldown) {
        console.log(`[${formatChinaTime()}] 通知冷却期内，跳过发送`);
        return;
      }

      // 4. 获取错误详情
      const errorDetails = await this.getLastError();
      if (!errorDetails) {
        console.warn(`[通知服务] 无法获取错误详情`);
        return;
      }

      // 5. 发送通知
      console.log(`[${formatChinaTime()}] 达到失败阈值，准备发送通知...`);
      const result = await this.sendFailureNotification(errorDetails);

      if (result.success) {
        // 6. 设置冷却期
        await this.setCooldown();
        console.log(`[${formatChinaTime()}] 通知已发送，冷却期: ${this.cooldownSeconds / 60} 分钟`);
      } else if (result.skipped) {
        console.log(`[${formatChinaTime()}] 通知功能未配置，跳过发送`);
      } else {
        console.error(`[${formatChinaTime()}] 通知发送失败`);
      }
    } catch (error) {
      console.error(`[通知服务] 处理失败异常:`, error.message);
    }
  }
}

module.exports = new NotificationService();
