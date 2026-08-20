const axios = require("axios");
const config = require("../config/env");
const logger = require("../utils/logger");

/**
 * Ark Game（game.arkengine.me）市场行情 API 封装
 *
 * 鉴权方式：显式 Cookie header（从环境变量 ARK_GAME_COOKIE 注入）
 * - 服务端为 Node.js 后端，无浏览器 cookie jar，axios 的 withCredentials 在 Node 端不生效
 * - 用户脚本在浏览器中用 credentials:"include" 是因为天然持有同源会话；服务端必须手动传 cookie
 * - 不再需要 new-api-user 头（旧 windhub.cc 才需要）
 */
class ArkGameAPI {
  constructor() {
    this.baseUrl = config.arkGame.baseUrl;
    this.cookie = config.arkGame.cookie;
    this.timeout = config.arkGame.timeout;
    this.retries = config.arkGame.retries;
    this.retryDelay = config.arkGame.retryDelay;
  }

  /**
   * 延迟工具函数
   * @param {number} ms - 延迟毫秒数
   * @returns {Promise<void>}
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 获取市场数据（带重试）
   * GET /api/stock — 返回根对象 { enabled, rules, stocks[], ticks[], positions[], rounds[], myBets[] }
   * @param {number} attempt - 当前重试次数
   * @returns {Promise<Object>} 市场数据（根对象）
   */
  async fetchMarketData(attempt = 1) {
    try {
      const response = await axios.get(`${this.baseUrl}/api/stock`, {
        headers: {
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "cache-control": "no-cache",
          cookie: this.cookie, // 显式 Cookie header，Node 端无 cookie jar
          referer: `${this.baseUrl}/`,
        },
        timeout: this.timeout,
      });

      // 验证响应：新接口直接返回根对象，包含 stocks 数组
      if (!response.data) {
        throw new Error("API 响应为空");
      }

      if (!Array.isArray(response.data.stocks)) {
        throw new Error(
          "API 响应数据格式错误: 缺少 stocks 字段或非数组",
        );
      }

      return response.data;
    } catch (error) {
      const isRetryable =
        (error.code === "ECONNABORTED" || // 超时
          error.code === "ECONNRESET" || // 连接被重置
          error.code === "ETIMEDOUT" || // DNS 连接超时
          error.code === "ENOTFOUND" || // DNS 解析失败
          error.code === "EAI_AGAIN" || // DNS 临时失败
          !error.response) && // 无响应（网络抖动）
        attempt <= this.retries;

      if (isRetryable) {
        logger.warn(
          "ArkGameAPI",
          `请求失败（第${attempt}次），${this.retryDelay}ms 后重试：${error.message}`,
        );
        await this.delay(this.retryDelay);
        return this.fetchMarketData(attempt + 1);
      }

      // 不可重试或已耗尽重试次数
      if (error.response) {
        throw new Error(
          `API 请求失败：${error.response.status} - ${error.response.statusText}`,
        );
      } else if (error.request) {
        throw new Error(
          `API 请求无响应（已重试${attempt}次）: ${error.message}`,
        );
      } else {
        throw error;
      }
    }
  }
}

module.exports = new ArkGameAPI();
