# CLAUDE.md

本文档为 Claude Code 在此代码库中工作时提供指导。

## 项目概述

Tampermonkey 脚本，为 windhub.cc 的 Ark API 模型股票创建监控面板。

**核心功能：**
- 多面板 UI（主面板、价格、交易、持仓、套利榜、设置），支持拖拽和主题切换
- 模型管理：选择器支持搜索、全选、清空
- 价格监控：自动/手动获取、历史表格、颜色编码价格变化
- 多图表系统：Lightweight Charts 实现，支持交易标记、价格线、拖拽调整大小
- 通知系统：价格突破提醒（弹窗、声音、Telegram）
- 活跃套利榜：24 小时价格波动排行
- 数据维护：自动清理旧数据（可配置保留天数）
- 数据持久化：通过 GM_setValue/GM_getValue 实现

## 架构

**单文件脚本** (~4937 行)，模块化组织：
1. 配置 (行 19-52) - CONFIG, DEFAULT_DATA
2. 存储 (行 54-96) - Storage (GM_setValue/GM_getValue)
3. 主题 (行 98-175) - Theme (主题切换和应用)
4. 工具函数 (行 177-246) - Utils, TimeUtils
5. API (行 248-355) - 市场数据、交易历史、模型列表接口
6. 数据处理 (行 357-646) - DataProcessor (数据处理、价格变化检测、通知检查)
7. 通知 (行 648-832) - Notification (弹窗、声音、Telegram 推送)
8. 定时任务 (行 834-879) - Scheduler (分钟尾数触发器)
9. 样式 (行 881-2245) - Styles (CSS 注入)
10. 图表 (行 2247-2570) - Chart (图表工具函数)
11. 图表管理 (行 2572-3009) - ChartManager, MultiPanelManagerClass
12. UI 面板工厂 (行 3011-4135) - UIPanels (面板创建)
13. UI 渲染器 (行 4137-4666) - UIRenderers (表格和数据渲染)
14. 交互 (行 4668-4833) - Interactions (拖拽和调整大小)
15. 业务入口 (行 4835-4905) - App (doFetch 主流程)
16. 启动 (行 4907-4937) - 初始化和菜单注册

**关键数据结构：**
- `models` - 监控模型列表
- `data` - 价格历史 `{modelName: [{timestamp: price}]}`
- `tradeHistory` - 交易记录（按模型分组）
- `positions` - 持仓数据
- `arbitrageData` - 套利数据（今日/昨日）
- `notifications` - 价格提醒配置
- `theme` - 主题设置 (dark/light)

**核心实现：**
- 认证：`localStorage.getItem("user")` 获取用户 ID，放入请求头 `new-api-user`
- API：动态 Base URL (`window.location.origin`)，支持 windhub.cc 和 test-fast.windhub.cc
- 主题：支持 dark/light 两种主题，通过 `Theme.toggle()` 切换，主题状态持久化
- 缓存：5 分钟缓存（模型列表、交易历史）
- 数据清理：按保留天数自动清理旧价格数据（默认 7 天）
- 价格变化：三态颜色编码（上涨/下跌/不变），价格不变时继承上一颜色
- 通知触发：价格从未突破到突破边界时触发
- 图表：Lightweight Charts v4.0.1，支持交易标记、高低价线、持仓成本线
- 表格显示限制：最近 5 条记录（`CONFIG.TABLE_DISPLAY_LIMIT = 5`）

## 开发指南

**修改代码：**
- 单文件 `ark-api-stock-monitor.user.js` (~4937 行)
- 数据结构更改需同步更新 `Storage.load()` (行 56-92) 和 `DEFAULT_DATA` (行 26-52)
- **版本号由用户手动更新**（不要自动修改 `@version`）

**调试：**
- 浏览器控制台查看日志（前缀：`[Ark Stock Monitor]`）
- `GM_getValue("windhub_stock_data")` 查看存储数据
- `ChartManager.getInstance()` 检查图表状态
- `Theme.current()` 查看当前主题

## API 与依赖

**Windhub API：**
- `${baseUrl}/api/user/self/stock/market` - 市场数据
- `${baseUrl}/api/user/self/stock/my-trades` - 交易历史
- 请求头：`new-api-user` (用户 ID)

**外部依赖：**
- Lightweight Charts v4.0.1 (jsDelivr CDN)
- Tampermonkey API (GM_setValue, GM_getValue, GM_registerMenuCommand, GM_addStyle, GM_xmlhttpRequest)
- Telegram Bot API (可选)

## 注意事项

- 数据不跨标签页同步
- 数据按天自动清理（默认保留 7 天）
- 图表数据点过多 (>10000) 可能影响性能
- 脚本仅运行在 windhub.cc 和 test-fast.windhub.cc
- 所有用户输入通过 `Utils.escapeHtml()` 转义防止 XSS