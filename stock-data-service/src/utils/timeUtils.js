/**
 * 时间工具函数
 */

/**
 * 格式化为东八区时间字符串
 * @param {Date|number} [date] - 可选的日期对象或时间戳，默认为当前时间
 * @returns {string} 格式: 2026-06-17 14:30:00
 */
function formatChinaTime(date = new Date()) {
  const options = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };

  const dateObj = typeof date === 'number' ? new Date(date) : date;
  return dateObj.toLocaleString('zh-CN', options).replace(/\//g, '-');
}

module.exports = {
  formatChinaTime
};
