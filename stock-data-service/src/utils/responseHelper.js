/**
 * API 响应助手函数
 * 统一处理 Express 路由的响应和错误
 */

/**
 * 发送成功响应
 * @param {Object} res - Express response 对象
 * @param {*} data - 响应数据
 * @param {number} [statusCode=200] - HTTP 状态码
 */
function sendSuccess(res, data, statusCode = 200) {
  res.status(statusCode).json({
    success: true,
    data
  });
}

/**
 * 发送错误响应
 * @param {Object} res - Express response 对象
 * @param {string} error - 错误消息
 * @param {number} [statusCode=500] - HTTP 状态码
 */
function sendError(res, error, statusCode = 500) {
  res.status(statusCode).json({
    success: false,
    error
  });
}

/**
 * 统一的错误处理中间件包装器
 * @param {string} routeName - 路由名称（用于日志）
 * @param {Function} handler - 异步路由处理函数
 * @returns {Function} Express 路由处理函数
 */
function asyncHandler(routeName, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      console.error(`[API错误] ${routeName}:`, error.message);
      sendError(res, '服务器内部错误', 500);
    }
  };
}

module.exports = {
  sendSuccess,
  sendError,
  asyncHandler
};
