# CLAUDE.md

本文档为 Claude Code 在此代码库中工作时提供指导。

## 项目概述

Tampermonkey 脚本，为 game.arkengine.me 的 Ark API 模型股市创建监控面板（原 windhub.cc 站点已迁移至此）。

**核心功能：**
- 多面板 UI（主面板、价格、持仓、套利幅度榜、交易记录、设置、数据维护），支持拖拽和主题切换
- 模型管理：选择器支持搜索、全选、清空，以 stockId 为主键
- 价格监控：自动/手动获取、历史表格、颜色编码价格变化
- 多图表系统：Lightweight Charts 实现，支持价格线（今日高/低、持仓成本线）、买卖点交易标记、拖拽调整大小
- 通知系统：价格突破提醒（弹窗、声音、Telegram、Bark iOS）
- 套利幅度榜：按所选「最近天数」区间计算的 每股套利幅度排行（单一实时榜；默认只看未停滞模型）
- 买入/卖出交易：行情右键菜单一键下单，前端实时校验（余额/持仓/手续费/休市/锁定），并本地记录交易历史
- 交易记录面板：展示通过本脚本成功买卖的历史（模型下拉筛选，买红卖绿）
- 市场状态：展示开闭市、买卖手续费、持仓时长
- 数据维护：自动清理旧数据（可配置保留天数）
- 数据持久化：通过 GM_setValue/GM_getValue 实现，含旧版数据迁移

## 架构

**单文件脚本** `ark-game-stock-monitor.user.js` (~6680 行)，模块化组织：
1. 配置 (行 24-38) - CONFIG（含 STORAGE_KEY）
2. 数据结构 (行 39-80) - DEFAULT_DATA（主键为 stockId）
3. 存储 (行 81-248) - Storage（GM_setValue/GM_getValue/GM_deleteValue + 旧数据迁移 migrateFromLegacy）
4. 主题 (行 249-327) - Theme（主题切换和应用）
5. 工具函数 (行 328-479) - Utils（含 getModelName 反查）、TimeUtils
6. API (行 480-636) - 市场数据 GET /api/stock、买入卖出 POST /api/stock、余额 /api/me/balance、模型列表
7. 数据处理 (行 637-937) - DataProcessor（价格变化检测、持仓派生、套利数据、通知检查、recordTrade 本地交易记录）
8. 通知 (行 940-1174) - Notification（弹窗、声音、Telegram、Bark 推送）
9. 定时任务 (行 1176-) - Scheduler（分钟尾数触发器）
10. 样式 (行 -) - Styles（CSS 注入）
11. 图表 (行 ~2794-) - Chart（图表工具函数，含 enrichWithTradePrices/convertToMarkers 交易标记）
12. 图表管理 (行 ~3116-) - ChartManager, MultiPanelManagerClass
13. UI 面板工厂 (行 ~3620-) - UIPanels（面板创建，含买入/卖出交易面板与交易记录面板）
14. UI 渲染器 (行 ~5266-) - UIRenderers（表格和数据渲染，含交易记录表）
15. 交互 (行 ~6210-) - Interactions（拖拽和调整大小）
16. 业务入口 (行 ~6345-) - App（doFetch 主流程）
17. 启动 (行 ~6410-) - 初始化、迁移触发、菜单注册

**关键数据结构（主键均为 stockId）：**
- `stockIds` - 监控的 stockId 数组
- `idToModel` - stockId → modelName 映射（每次 /api/stock 拉取刷新）
- `priceData` - 价格历史 `{[stockId]: [[秒时间戳, 代币价格]]}`
- `positions` - 持仓数据 `{[stockId]: {shares, avg_cost, locked_until, pnl...}}`
- `tradeHistory` - 交易历史 `{[stockId]: [{id, side, shares, price, gross, fee, net, created_at}]}`（仅记录通过本脚本成功买卖，本地保存）
- `arbitrageData` - 套利数据（全模型快照数组，含 stale 标记与 24h 高/低，键为 stockId）
- `notifications` - 价格提醒配置（键为 stockId）
- `marketRules` - 市场状态 `{enabled, rules}` 快照
- `userTokens` - 可用代币（整数，来自 /api/me/balance）
- `theme` - 主题设置 (dark/light)

## 核心实现

- **认证**：同源 cookie 鉴权（`ptd_session`），`fetch` + `credentials: "include"`，无请求头鉴权
- **API**：`window.location.origin` + `GET /api/stock`（行情）、`POST /api/stock`（买入/卖出）、`/api/me/balance`（代币）
- **买入/卖出**：右键模型名打开一级菜单（买入/卖出/颜色标识），`UIPanels.openTradePanel` 打开单例交易面板；前端按实时行情 + 余额校验（手续费、休市、持仓锁定、股数范围），提交走 `API.submitTrade`（POST /api/stock，`idempotencyKey` 幂等）
- **交易历史**：交易成功后在 `DataProcessor.recordTrade`（行 ~907）写入 `data.tradeHistory[stockId]`（按 id 去重、升序）；接口不提供交易历史，仅供本脚本展示与图表标记
- **交易记录面板**：模型下拉筛选（默认「全部」，模型名按英文 A→Z 排）+ 表格（时间/模型/方向/价格/股数/成交额/手续费/余额变化），买红卖绿；无清空按钮（本地数据不可恢复）
- **走势图交易标记**：`Chart.enrichWithTradePrices`(补入交易价数据点) + `Chart.convertToMarkers`(吸附到数据点) + `series.setMarkers`，买红 `#F55454` 卖绿 `#00A854`；均复用已有死代码函数
- **右键菜单**：`UIRenderers.showTradeContextMenu` 取代原 `showColorMenu`，卖出生效项需有持仓，颜色标识下沉为二级浮层（`_buildColorSubmenu`）
- **主键策略**：全部用 stockId 串联，展示模型名时通过 `idToModel` 查表（规避模型改名/重名风险）
- **价格历史时间戳**：stale=false（活跃）模型，取 ticks 前 n 条按 stockId 匹配的 createdAt（秒）
- **stale 语义**：`stale === false` 表示数据新鲜/活跃（本轮有 tick），套利幅度榜为「未停滞」，显示绿色；`stale === true` 表示数据陈旧（无 tick），为「停滞」，显示红色
- **价格单位**：代币（priceCents/100），1 代币 = 100 分；余额 tokens 为整数代币
- **持仓派生**：费率从 `rules.buyFeePct`/`sellFeePct` 取（非硬编码），现价从 stocks 映射
- **持仓总值**：本地累加 `Σ(shares × priceCents/100)`，与 userTokens 同口径
- **主题**：dark/light 两种主题，通过 `Theme.toggle()` 切换，状态持久化
- **缓存**：5 分钟缓存（模型列表 idToModel）
- **数据清理**：按保留天数自动清理旧价格数据（默认 7 天）
- **价格变化**：三态颜色编码（上涨/下跌/不变），价格不变时继承上一颜色
- **通知触发**：价格从未突破到突破边界时触发；guard 检查全部 4 个渠道（含 Bark）
- **图表**：Lightweight Charts v4.0.1，价格线（今日高/低、持仓成本线）；交易标记（买红 `#F55454` / 卖绿 `#00A854`，数据来自本地 `tradeHistory`）
- **表格显示限制**：最近 5 条记录（`CONFIG.TABLE_DISPLAY_LIMIT = 5`）
- **旧数据迁移**：`Storage.migrateFromLegacy()` 首次启动迁移 windhub_stock_data（通用配置 + API 查表重建 stockId 键），`legacyMigrated` 标志防重复执行，迁移成功后旧 key 即删除

## 开发指南

**修改代码：**
- 单文件 `ark-game-stock-monitor.user.js` (~6680 行)
- 数据结构更改需同步更新 `Storage.load()` (行 81-)、`DEFAULT_DATA` (行 39-)、并考虑 `migrateFromLegacy()` 兼容
- **版本号由用户手动更新**（不要自动修改 `@version`）

**相关文件：**
- `archive/ark-api-stock-monitor.user.js` - 归档的旧版（对接 windhub.cc）
- `stock-data-service/` - 自建价格数据服务（后续将适配新脚本，当前与新脚本接口契约未对齐）

**调试：**
- 浏览器控制台查看日志（前缀：`[Ark Stock Monitor]`）
- `GM_getValue("ark_game_stock_data")` 查看存储数据（键已改为 ark_game_stock_data）
- `GM_getValue("windhub_stock_data")` 旧版数据（迁成功后已删除，仅迁移前可见）
- `ChartManager.getInstance()` 检查图表状态
- `Theme.current()` 查看当前主题

## API 与依赖

**game.arkengine.me API：**
- `GET ${baseUrl}/api/stock` - 市场行情（enabled/rules/stocks/positions/rounds/myBets/ticks）
- `GET ${baseUrl}/api/me/balance` - 代币余额（返回 tokens/diamonds/tickets）
- 鉴权：同源 cookie（`credentials: "include"`）

**外部依赖：**
- Lightweight Charts v4.0.1 (jsDelivr CDN)
- Tampermonkey API (GM_setValue, GM_getValue, GM_registerMenuCommand, GM_addStyle, GM_xmlhttpRequest)
- Telegram Bot API / Bark（可选，跨域用 GM_xmlhttpRequest）

## 注意事项

- 数据不跨标签页同步
- 数据按天自动清理（默认保留 7 天）
- 图表数据点过多 (>10000) 可能影响性能
- 脚本仅运行在 game.arkengine.me（@match 限定）
- 所有用户输入通过 `Utils.escapeHtml()` 转义防止 XSS
- stale 语义易混淆：stale=false 才是活跃/新鲜（有 tick），stale=true 表示陈旧