const axios = require("axios");
const config = require("../config/env");
const logger = require("../utils/logger");

class WindhubAPI {
  constructor() {
    this.baseUrl = config.windhub.baseUrl;
    this.userId = config.windhub.userId;
    this.cookie = config.windhub.cookie;
    this.timeout = config.windhub.timeout;
    this.retries = config.windhub.retries;
    this.retryDelay = config.windhub.retryDelay;
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
   * @param {number} attempt - 当前重试次数
   * @returns {Promise<Object>} 市场数据
   */
  async fetchMarketData(attempt = 1) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/api/user/self/stock/market`,
        {
          headers: {
            accept: "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
            "cache-control": "no-store",
            cookie: this.cookie,
            "new-api-user": String(this.userId),
            priority: "u=1, i",
            referer: `${this.baseUrl}/console/model-stock`,
            "sec-ch-ua": '"Chromium";v="149", "Not)A;Brand";v="24"',
            "sec-ch-ua-mobile": "?1",
            "sec-ch-ua-platform": '"Android"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent":
              "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
          },
          timeout: this.timeout,
        },
      );

      // 验证响应
      if (!response.data || !response.data.success) {
        throw new Error("API 返回失败 : " + JSON.stringify(response.data));
      }

      if (!response.data.data || !response.data.data.stocks) {
        throw new Error("API 响应数据格式错误 : 缺少 stocks 字段");
      }

      return response.data.data;
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
          "WindhubAPI",
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

module.exports = new WindhubAPI();
