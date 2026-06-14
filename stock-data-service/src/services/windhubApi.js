const axios = require("axios");
const config = require("../config/env");

class WindhubAPI {
  constructor() {
    this.baseUrl = config.windhub.baseUrl;
    this.userId = config.windhub.userId;
    this.cookie = config.windhub.cookie;
  }

  /**
   * 获取市场数据
   * @returns {Promise<Object>} 市场数据
   */
  async fetchMarketData() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/api/user/self/stock/market`,
        {
          headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
            'cache-control': 'no-store',
            'cookie': this.cookie,
            'new-api-user': String(this.userId),
            'priority': 'u=1, i',
            'referer': `${this.baseUrl}/console/model-stock`,
            'sec-ch-ua': '"Chromium";v="149", "Not)A;Brand";v="24"',
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"Android"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
          },
        },
      );

      // 验证响应
      if (!response.data || !response.data.success) {
        throw new Error("API返回失败: " + JSON.stringify(response.data));
      }

      if (!response.data.data || !response.data.data.stocks) {
        throw new Error("API响应数据格式错误: 缺少stocks字段");
      }

      return response.data.data;
    } catch (error) {
      if (error.response) {
        throw new Error(
          `API请求失败: ${error.response.status} - ${error.response.statusText}`,
        );
      } else if (error.request) {
        throw new Error("API请求无响应");
      } else {
        throw error;
      }
    }
  }
}

module.exports = new WindhubAPI();
