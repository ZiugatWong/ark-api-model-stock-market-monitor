const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const logger = require('../utils/logger');

const CHANGELOG_PATH = path.join(__dirname, '..', '..', 'changelog.md');

// mtime 缓存：文件未变时直接复用上次解析结果，改文件即时生效、无需重启
let cache = { mtimeMs: null, html: '' };

/**
 * 读取 changelog.md 并转为 HTML（带 mtime 缓存）
 * @returns {Promise<string>} HTML 内容；文件缺失/读取失败返回空字符串（前端显示「暂无更新日志」）
 */
async function getChangelogHtml() {
  let stat;
  try {
    stat = await fs.promises.stat(CHANGELOG_PATH);
  } catch (e) {
    // 文件不存在视为未配置更新日志；其他读取错误记日志后同样按空处理
    if (e.code !== 'ENOENT') {
      logger.warn('日志', `读取 changelog.md 失败: ${e.message}`);
    }
    return '';
  }

  if (cache.mtimeMs === stat.mtimeMs) {
    return cache.html;
  }

  try {
    const md = await fs.promises.readFile(CHANGELOG_PATH, 'utf8');
    const html = marked.parse(md);
    cache = { mtimeMs: stat.mtimeMs, html };
    logger.log('日志', 'changelog.md 已加载（转换为 HTML）');
    return html;
  } catch (e) {
    logger.warn('日志', `解析 changelog.md 失败: ${e.message}`);
    return '';
  }
}

module.exports = { getChangelogHtml };
