const express = require('express');
const redis = require('../config/redis');
const priceStorage = require('../services/priceStorage');
const syncScheduler = require('../services/syncScheduler');

const router = express.Router();

/**
 * POST /api/prices/batch
 * 批量查询多个模型的价格数据
 */
router.post('/prices/batch', async (req, res) => {
  try {
    const { models, days } = req.body;

    // 参数验证
    if (!models || !Array.isArray(models) || models.length === 0) {
      return res.status(400).json({
        success: false,
        error: '参数错误: models必须是非空数组'
      });
    }

    const queryDays = days && Number.isInteger(days) && days > 0 ? days : 7;

    // 查询数据
    const data = await priceStorage.getBatchPrices(models, queryDays);

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[API错误] /api/prices/batch:', error.message);
    res.status(500).json({
      success: false,
      error: '服务器内部错误'
    });
  }
});

/**
 * GET /api/models
 * 获取所有可用模型列表
 */
router.get('/models', async (req, res) => {
  try {
    const models = await priceStorage.getAllModels();

    res.json({
      success: true,
      data: {
        models,
        count: models.length
      }
    });
  } catch (error) {
    console.error('[API错误] /api/models:', error.message);
    res.status(500).json({
      success: false,
      error: '服务器内部错误'
    });
  }
});

/**
 * POST /api/sync
 * 手动触发同步（用于测试）
 */
router.post('/sync', async (req, res) => {
  try {
    // 异步执行同步任务
    syncScheduler.syncPrices().catch(err => {
      console.error('[手动同步错误]:', err.message);
    });

    res.json({
      success: true,
      message: '同步任务已触发'
    });
  } catch (error) {
    console.error('[API错误] /api/sync:', error.message);
    res.status(500).json({
      success: false,
      error: '服务器内部错误'
    });
  }
});

module.exports = router;
