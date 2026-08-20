const redis = require('../config/redis');
const REDIS_KEYS = require('../constants/redisKeys');
const { DATA_RETENTION_DAYS } = require('../constants/business');

class PriceStorage {
  /**
   * 批量查询多个模型的价格数据（主键 stockId）
   * @param {number[]} stockIds - stockId 列表
   * @param {number} days - 查询天数，默认使用配置的保留天数
   * @returns {Promise<Object>} 格式: {stockId: [{timestamp, price}, ...]}
   */
  async getBatchPrices(stockIds, days = DATA_RETENTION_DAYS) {
    if (!stockIds || stockIds.length === 0) {
      return {};
    }

    const startTime = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

    // 使用 Pipeline 批量查询
    const pipeline = redis.pipeline();
    stockIds.forEach(id => {
      pipeline.zrangebyscore(REDIS_KEYS.PRICE(id), startTime, '+inf');
    });

    const results = await pipeline.exec();

    // 组装返回数据（key 为 stockId）
    return stockIds.reduce((acc, id, idx) => {
      const members = results[idx][1] || [];
      acc[id] = members.map(member => {
        const [timestamp, price] = member.split(':');
        return {
          timestamp: parseInt(timestamp),
          price: parseFloat(price)
        };
      });
      return acc;
    }, {});
  }

  /**
   * 获取所有可用 stockId 列表
   * @returns {Promise<number[]>} stockId 列表（升序）
   */
  async getAllStockIds() {
    const ids = await redis.smembers(REDIS_KEYS.STOCK_IDS_ALL);
    return ids
      .map(id => parseInt(id))
      .filter(id => Number.isInteger(id))
      .sort((a, b) => a - b);
  }
}

module.exports = new PriceStorage();
