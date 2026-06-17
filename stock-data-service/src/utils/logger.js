/**
 * 日志工具模块
 * 提供带时间戳的日志打印功能
 */

const { formatChinaTime } = require('./timeUtils');

/**
 * 格式化日志消息
 * @param {string} level - 日志级别
 * @param {string} tag - 日志标签
 * @param  {...any} args - 日志参数
 */
function formatLog(level, tag, ...args) {
  const timestamp = formatChinaTime();
  const prefix = `[${timestamp}] [${level}] [${tag}]`;
  return [prefix, ...args];
}

/**
 * 日志记录器
 */
const logger = {
  /**
   * 普通日志
   * @param {string} tag - 日志标签
   * @param  {...any} args - 日志参数
   */
  log(tag, ...args) {
    console.log(...formatLog('INFO', tag, ...args));
  },

  /**
   * 信息日志（log 的别名）
   * @param {string} tag - 日志标签
   * @param  {...any} args - 日志参数
   */
  info(tag, ...args) {
    console.log(...formatLog('INFO', tag, ...args));
  },

  /**
   * 警告日志
   * @param {string} tag - 日志标签
   * @param  {...any} args - 日志参数
   */
  warn(tag, ...args) {
    console.warn(...formatLog('WARN', tag, ...args));
  },

  /**
   * 错误日志
   * @param {string} tag - 日志标签
   * @param  {...any} args - 日志参数
   */
  error(tag, ...args) {
    console.error(...formatLog('ERROR', tag, ...args));
  }
};

module.exports = logger;
