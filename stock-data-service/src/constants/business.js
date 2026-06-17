/**
 * 业务常量配置
 * 统一管理业务相关的常量值
 */

const BUSINESS_CONSTANTS = {
  // 数据保留期（天）
  DATA_RETENTION_DAYS: 7,

  // 数据保留期（秒）
  DATA_RETENTION_SECONDS: 7 * 24 * 60 * 60,

  // TTL 兜底时间（比保留期多1天）
  DATA_TTL_SECONDS: 8 * 24 * 60 * 60,

  // 缓存过期时间
  CACHE_TTL: {
    MODELS_LIST: 3600,        // 模型列表缓存：1小时
    FAILURE_COUNT: 3600,      // 失败计数：1小时
    ERROR_DETAILS: 3600       // 错误详情：1小时
  }
};

module.exports = BUSINESS_CONSTANTS;
