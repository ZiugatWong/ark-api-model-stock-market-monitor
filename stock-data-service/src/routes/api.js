const express = require('express');
const redis = require('../config/redis');
const priceStorage = require('../services/priceStorage');
const syncScheduler = require('../services/syncScheduler');
const { sendSuccess, sendError, asyncHandler } = require('../utils/responseHelper');
const { DATA_RETENTION_DAYS } = require('../constants/business');

const router = express.Router();

/**
 * POST /api/prices/batch
 * 批量查询多个模型的价格数据
 */
router.post('/prices/batch', asyncHandler('/api/prices/batch', async (req, res) => {
  const { models, days } = req.body;

  // 参数验证
  if (!models || !Array.isArray(models) || models.length === 0) {
    return sendError(res, '参数错误: models必须是非空数组', 400);
  }

  const queryDays = days && Number.isInteger(days) && days > 0 ? days : DATA_RETENTION_DAYS;

  // 查询数据
  const data = await priceStorage.getBatchPrices(models, queryDays);

  sendSuccess(res, data);
}));

/**
 * GET /api/models
 * 获取所有可用模型列表
 */
router.get('/models', asyncHandler('/api/models', async (req, res) => {
  const models = await priceStorage.getAllModels();

  sendSuccess(res, {
    models,
    count: models.length
  });
}));

/**
 * POST /api/sync
 * 手动触发同步（用于测试）
 */
router.post('/sync', asyncHandler('/api/sync', async (req, res) => {
  // 异步执行同步任务
  syncScheduler.syncPrices().catch(err => {
    console.error('[手动同步错误]:', err.message);
  });

  sendSuccess(res, { message: '同步任务已触发' });
}));

module.exports = router;
