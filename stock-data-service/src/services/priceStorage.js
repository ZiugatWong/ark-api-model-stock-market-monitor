const redis = require('../config/redis');
const REDIS_KEYS = require('../constants/redisKeys');
const { DATA_RETENTION_DAYS } = require('../constants/business');

class PriceStorage {
  /**
   * 批量查询多个模型的价格数据
   * @param {string[]} modelNames - 模型名称列表
   * @param {number} days - 查询天数，默认使用配置的保留天数
   * @returns {Promise<Object>} 格式: {modelName: [{timestamp, price}, ...]}
   */
  async getBatchPrices(modelNames, days = DATA_RETENTION_DAYS) {
    if (!modelNames || modelNames.length === 0) {
      return ;
    }

    const startTime = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

    // 使用Pipeline批量查询
    const pipeline = redis.pipeline();
    modelNames.forEach(name => {
      pipeline.zrangebyscore(REDIS_KEYS.PRICE(name), startTime, '+inf');
    });

    const results = await pipeline.exec();

    // 组装返回数据
    return modelNames.reduce((acc, name, idx) => {
      const members = results[idx][1] || [];
      acc[name] = members.map(member => {
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
   * 获取所有可用模型列表
   * @returns {Promise<string[]>} 模型名称列表
   */
  async getAllModels() {
    const models = await redis.smembers(REDIS_KEYS.MODELS_ALL);
    return models.sort();
  }
}

module.exports = new PriceStorage();
