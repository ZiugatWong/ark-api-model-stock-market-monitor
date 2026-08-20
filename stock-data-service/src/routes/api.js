const express = require('express');
const priceStorage = require('../services/priceStorage');
const syncScheduler = require('../services/syncScheduler');
const { sendSuccess, sendError, asyncHandler } = require('../utils/responseHelper');
const { DATA_RETENTION_DAYS } = require('../constants/business');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/prices/batch
 * 批量查询多个模型的价格数据（主键 stockId）
 */
router.post('/prices/batch', asyncHandler('/api/prices/batch', async (req, res) => {
  const { stockIds, days } = req.body;

  // 参数验证
  if (!stockIds || !Array.isArray(stockIds) || stockIds.length === 0) {
    return sendError(res, '参数错误: stockIds 必须是非空数组', 400);
  }

  // 兼容字符串数字：服务端统一转为整数
  const normalizedIds = stockIds.map(id => Number(id));
  if (!normalizedIds.every(id => Number.isInteger(id))) {
    return sendError(res, '参数错误: stockIds 必须全部为整数', 400);
  }

  const queryDays = days && Number.isInteger(days) && days > 0 ? days : DATA_RETENTION_DAYS;

  // 查询数据
  const data = await priceStorage.getBatchPrices(normalizedIds, queryDays);

  sendSuccess(res, data);
}));

/**
 * GET /api/stock-ids
 * 获取所有可用 stockId 列表
 */
router.get('/stock-ids', asyncHandler('/api/stock-ids', async (req, res) => {
  const stockIds = await priceStorage.getAllStockIds();

  sendSuccess(res, {
    stockIds,
    count: stockIds.length
  });
}));

/**
 * POST /api/sync
 * 手动触发同步（用于测试）
 */
router.post('/sync', asyncHandler('/api/sync', async (req, res) => {
  // 异步执行同步任务
  syncScheduler.syncPrices().catch(err => {
    logger.error('手动同步', '错误:', err.message);
  });

  sendSuccess(res, { message: '同步任务已触发' });
}));

module.exports = router;
