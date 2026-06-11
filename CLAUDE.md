# CLAUDE.md

本文档为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 项目概述

这是一个 Tampermonkey (UserScript) 项目，为 windhub.cc 网站上的 Ark API 模型股票价格创建监控面板。该脚本提供实时价格跟踪、自动化数据获取和 AI 模型股票价格可视化。

**主要功能：**
- 多面板 UI 系统，所有面板支持拖拽、独立显示/隐藏
- 模型管理（添加/删除要跟踪的模型），支持下拉选择器、搜索、全选、清空功能
- 基于分钟尾数触发器的自动价格获取（可配置）
- 手动数据获取和刷新能力（支持实时刷新按钮）
- 价格历史表格显示最近 10 条记录，支持动态列宽度
- 颜色编码的价格变化（绿色表示上涨，红色表示下跌）
- 多图表系统：单个模型的分时走势图（使用 Lightweight Charts 库），支持：
  - 多图表同时打开，独立管理
  - 拖拽、缩放、八向调整大小
  - 交易标记、今日高低价线、持仓成本线
  - 数据自动刷新
  - ESC 快捷键关闭
- 价格突破通知系统，支持弹窗、声音提示、Telegram 推送
- 交易历史查看和管理（按模型筛选，自动/手动刷新）
- 持仓信息展示（实时余额、持仓总值、解锁状态）
- 活跃套利榜功能，展示最近 30 分钟内活跃模型的 24 小时价格波动，支持：
  - 今日/昨日数据切换
  - 按价差/幅度排序
  - 一键添加/移除监控
- 数据维护功能：价格数据保留天数设置（自动清理旧数据）
- 通过 Tampermonkey 的 GM_setValue/GM_getValue API 实现数据持久化
- 数据缓存机制（5 分钟），减少重复 API 调用

## 文件结构

- `ark-api-stock-monitor.user.js` - 主要的 Tampermonkey 脚本（单文件实现，约 4500+ 行）
- `PLAN.md` - 原始实现计划和规范
- `CLAUDE.md` - 项目文档（本文件）
- `.claude/` - Claude Code 配置目录

## 架构

### 数据存储
脚本使用 Tampermonkey 的 `GM_setValue`/`GM_getValue` API 进行数据持久化，结构如下：
```javascript
{
  "models": ["glm-5.1-chat", "glm-5-chat", "gemma-4-31b-it"], // 监控的模型列表
  "autoTriggerMinuteEnds": "3,8", // 自动触发的分钟尾数
  "autoTrigger": false, // 是否启用自动获取
  "lastUpdateTime": null, // 最后更新时间（毫秒）
  "availableModels": [], // 可用模型列表缓存
  "availableModelsLastFetched": null, // 模型列表最后获取时间
  "notificationSettings": {
    "enablePopup": false, // 弹窗通知
    "enableSound": false, // 声音通知
    "enableTelegram": false, // Telegram 通知
    "telegramBotToken": null, // Telegram Bot Token
    "telegramChatId": null, // Telegram Chat ID
  },
  "notifications": { // 价格提醒配置，key 为模型名
    "model-name": {
      "upperLimit": 120, // 向上突破价格
      "lowerLimit": 100  // 向下突破价格
    }
  },
  "data": { // 价格历史数据
    "glm-5.1-chat": [
      { "1777737057": 117.93 }, // key: 时间戳(秒), value: 价格
      { "1777738057": 118.05 }
    ]
  },
  "tradeHistory": { // 交易历史数据，按模型分组
    "model-name": [
      {
        "id": 12345,
        "side": "buy", // "buy" 或 "sell"
        "shares": 10,
        "price": 100.5,
        "gross": 500000, // 原始单位（需除以1000000再乘2）
        "fee": -2500,
        "net": -502500,
        "created_at": 1777737057
      }
    ]
  },
  "tradeHistoryLastFetched": null, // 交易历史最后获取时间
  "arbitrageData": { // 套利数据
    "today": [
      {
        "model_name": "glm-5-chat",
        "high_24h": 125.50,
        "low_24h": 98.30,
        "arbitrage_diff": 27.20,
        "arbitrage_percent": 27.67
      }
    ],
    "yesterday": [] // 昨日数据
  },
  "arbitrageDataLastDate": "2026-06-11", // 最后套利数据日期
  "positions": { // 持仓数据（仅保留最新，不保留历史）
    "model-name": {
      "model_name": "glm-5-chat",
      "shares": 50,
      "avg_cost": 102.30,
      "locked_until": 1777800000 // 解锁时间戳（秒）
    }
  },
  "priceDataDaysLimit": 7, // 价格数据保留天数
  "lastPriceDataCleanDate": "2026-06-11", // 最后清理日期
  "userQuota": 1500.00, // 用户可用余额（美元）
  "holdingsTotalValue": 5000.00 // 持仓总值（美元）
}
```

### 核心组件

#### 1. 配置与工具 (CONFIG, Utils, TimeUtils)
- `CONFIG` - 全局配置常量（存储键、显示限制、缓存时长）
- `Utils` - 工具函数（HTML 转义、用户 ID 获取、时间格式化、Base URL 获取）
- `TimeUtils` - 时间格式化工具（别名到 Utils 的时间函数）

#### 2. 数据管理 (Storage)
- `Storage.load()` - 从 GM_getValue 加载数据，提供默认值和数据迁移
- `Storage.save()` - 将数据保存到 GM_setValue

#### 3. API 集成 (API)
- `API.fetchMarketData()` - 获取市场数据（价格、持仓、余额）
- `API.fetchTradeHistory(forceRefresh)` - 获取交易历史，支持缓存（5分钟）
- `API.fetchAvailableModels(forceRefresh)` - 获取可用模型列表，支持缓存

#### 4. 数据处理 (DataProcessor)
- `processMarketData(response)` - 解析市场 API 响应，更新价格、持仓、余额数据，自动清理超过保留天数的旧数据
- `processTradeHistory(tradesArray)` - 处理交易历史数据，去重、排序
- `processArbitrageData(response)` - 处理套利数据，计算价差和幅度，支持今日/昨日数据
- `getModelsWithTradeHistory()` - 获取有交易记录的模型列表
- `checkNotifications(deduplicatedModels)` - 检查价格突破条件，触发通知

#### 5. 通知系统 (Notification)
- `showPopup(triggered)` - 显示浏览器内弹窗通知（可拖拽）
- `playSound()` - 播放双音提示音（使用 Web Audio API）
- `sendTelegram(triggered)` - 通过 Telegram Bot API 发送推送
- `sendBatch(triggered)` - 批量发送通知（根据设置选择通知方式）
- `sendTest()` - 发送测试通知

#### 6. 调度器 (Scheduler)
- `start()` - 启动定时任务，在分钟开头对齐执行
- `stop()` - 停止定时任务
- `_checkAndTrigger()` - 检查当前分钟尾数是否匹配，触发数据获取

#### 7. 样式系统 (Styles)
- `inject()` - 通过 GM_addStyle 注入所有 CSS 样式（面板、按钮、表格、动画等）

#### 8. 图表系统 (Chart, ChartManager, MultiPanelManagerClass)
- **Chart** - 图表工具函数集合：
  - `convertToChartData()` - 转换原始数据为图表数据格式
  - `calculatePriceStats()` - 计算价格统计（最高、最低、平均、涨跌幅）
  - `convertToMarkers()` - 转换交易记录为图表标记
  - `createDarkThemeChart()` - 创建深色主题图表实例
  - `createPriceLineSeries()` - 创建价格线序列
  - `createChartTooltip()` - 创建交互式 tooltip
  - `createChartPanelElement()` - 创建图表面板 DOM 元素
  - `updateChartStatsDisplay()` - 更新图表统计信息显示
  - `showChartError()` - 显示图表错误提示
- **ChartManager** - 单例模式图表管理器入口
- **MultiPanelManagerClass** - 多图表面板管理器：
  - 管理多个独立图表面板（Map 存储）
  - 支持图表数据刷新、加载状态、错误处理
  - 面板激活、关闭、位置管理
  - ESC 快捷键支持

#### 9. UI 面板工厂 (UIPanels)
- `createMainPanel()` - 主监控面板：模型选择器、市场入口、版本信息
- `createSettingsPanel()` - 设置面板：自动触发、通知设置、价格提醒配置
- `createDataMaintenancePanel()` - 数据维护面板：价格数据保留天数设置
- `createPricePanel()` - 价格面板：最新价格表格、余额和持仓总值显示
- `createTradesPanel()` - 交易面板：按模型查看交易历史
- `createPositionsPanel()` - 持仓面板：当前持仓信息、解锁状态
- `createArbitragePanel()` - 活跃套利榜：24小时价格波动排行，支持添加/移除监控
- `_setupModelSelector()` - 模型选择器逻辑（下拉列表、搜索、全选、清空）

#### 10. UI 渲染器 (UIRenderers)
- `renderModelList()` - 渲染已监控模型列表（支持拖拽排序）
- `refreshPriceTable()` - 刷新价格表格（动态列宽、颜色编码、锁定状态）
- `renderTradesTable()` - 渲染交易记录表格
- `renderArbitrageTable()` - 渲染套利排行榜（支持添加/移除按钮）
- `refreshPositionsPanel()` - 刷新持仓面板
- `updateLastUpdateDisplayForPricePanel()` - 更新价格面板的最后更新时间
- `updateBalanceDisplay()` - 更新余额和持仓总值显示
- `refreshPricePanelFull()` - 完整刷新价格面板（数据+时间+余额）
- `updateTradesLastUpdateDisplay()` - 更新交易历史最后更新时间
- `populateTradesModelSelect()` - 填充交易面板的模型选择器
- `updateArbitrageLastUpdateDisplay()` - 更新套利榜最后更新时间

#### 11. 交互系统 (Interactions)
- `initDrag(el, panelIdOrHandle, manager)` - 初始化面板拖拽功能
- `initResize(panel, panelId, manager)` - 初始化图表面板八向调整大小功能

#### 12. 业务入口 (App)
- `doFetch()` - 执行数据获取的主流程：
  - 获取市场数据并处理
  - 更新 UI 面板
  - 刷新打开的图表
  - 检查并发送通知
  - 处理套利数据
  - 首次获取交易历史

### 关键实现细节

#### 认证与请求
- 使用 `localStorage.getItem("user")` 获取用户 ID 并包含在 API 请求头中（`new-api-user` 头）
- 支持多环境：`https://windhub.cc` 和 `https://test-fast.windhub.cc`
- 动态获取 Base URL：`window.location.origin`

#### 数据处理
- **价格变化检测**：比较当前价格与之前价格，使用三态颜色编码（上涨/下跌/不变）
- **价格变化继承**：当价格不变时，继承上一时刻的颜色状态
- **数据去重**：同一时间戳的价格数据不重复存储
- **数据清理**：每天自动清理超过 N-1 天前 0 点的旧数据（保留最近 N 个自然天）
- **数据限制**：每个模型最多存储的历史记录无上限（由保留天数控制），UI 显示最近 10 条
- **套利数据处理**：
  - 只统计最近 30 分钟内有价格更新的活跃模型
  - 支持今日/昨日数据，跨天自动迁移
  - 计算价差（绝对值）和幅度（百分比）

#### 时间处理
- 存储：Unix 时间戳（秒）
- 显示：转换为人类可读格式（yyyy-MM-dd HH:mm:ss）
- 时区：使用本地时区显示，图表使用 `localTimezoneOffset` 校正

#### 缓存机制
- API 请求结果缓存 5 分钟（`CONFIG.CACHE_DURATION = 5 * 60 * 1000`）
- 适用于：可用模型列表、交易历史
- 强制刷新：`forceRefresh` 参数

#### 通知系统
- **触发条件**：价格从未突破到突破边界（向上或向下）
- **去重处理**：忽略重复时间戳的数据点，避免重复通知
- **批量通知**：一次触发多个模型的突破，合并为单个通知
- **通知方式**：
  - 弹窗：可拖拽，自动显示多模型信息，价格闪烁动画
  - 声音：双音提示（880Hz + 440Hz）
  - Telegram：Bot API 推送，支持 Markdown 格式

#### 图表功能
- **多实例管理**：`Map` 存储，按 panelId 索引
- **图表库**：Lightweight Charts v4.0.1（从 jsDelivr CDN 加载）
- **数据转换**：原始数据 → 时间序列数据（time + value）
- **价格线标记**：
  - 今日最高价线（绿色虚线）
  - 今日最低价线（红色虚线）
  - 持仓成本线（棕色虚线，仅有持仓时显示）
- **交易标记**：买入（红色圆点，下方）、卖出（绿色圆点，上方）
- **时间范围**：默认显示昨日 0 点至最新时间
- **图表调整**：支持八向拖拽调整大小（N/S/E/W/NE/NW/SE/SW），实时 resize
- **数据刷新**：打开的图表在数据更新时自动刷新

#### 持仓和余额
- **余额显示**：`user_quota * 2 / 1000000` 转换为美元
- **持仓总值**：`holdings_total_value` 直接显示
- **持仓状态**：
  - 锁定中：`locked_until > now`，表格名称前显示 🔒
  - 已解锁：`locked_until < now`
  - 表格中显示持仓股数、均价、解锁时间

#### UI 特性
- **动态列宽**：价格表格根据监控模型数量动态调整宽度（`80px * 模型数 + 150px`）
- **拖拽排序**：已监控模型列表支持拖拽调整顺序
- **模型选择器**：
  - 搜索过滤
  - 全选/清空
  - 多选标签显示
  - 选中状态同步
- **链接式按钮**：使用 `ark-btn` 样式类（无背景，仅文字链接样式）
- **刷新按钮**：带旋转动画的刷新图标（↻），禁用状态处理
- **持仓高亮**：有持仓的模型在价格表格中名称显示为紫色

#### 性能优化
- 价格表格仅显示最近 10 条记录
- 数据按天自动清理，防止存储膨胀
- 图表使用高效的 Lightweight Charts 库
- 自动获取遵循分钟尾数触发器，避免过多 API 调用
- 数据缓存机制（5 分钟），减少重复 API 请求
- 异步加载和渲染，避免阻塞主线程

## 开发任务

### 测试脚本
1. 在 Tampermonkey 或 Violentmonkey 浏览器扩展中安装脚本
2. 访问 https://windhub.cc/ 或 https://test-fast.windhub.cc/
3. 点击 Tampermonkey 图标并选择"主监控面板"或"最新价格面板"
4. 验证面板出现并显示用户 ID、版本号
5. 使用模型选择器添加模型（支持搜索、全选、多选）
6. 测试手动/自动数据获取
7. 测试各功能面板：
   - 最新价格：表格显示、刷新按钮、余额显示、点击模型名打开图表
   - 活跃套利榜：排序切换、今日/昨日切换、添加/移除监控
   - 我的交易：模型筛选、刷新功能
   - 我的持仓：持仓列表、解锁状态
8. 测试通知功能（设置面板）：
   - 配置价格突破提醒
   - 测试弹窗、声音、Telegram 推送
9. 测试图表功能：
   - 打开多个模型图表
   - 拖拽、调整大小
   - 验证交易标记、高低价线、持仓成本线
   - ESC 关闭当前图表
10. 测试数据维护：
    - 设置价格数据保留天数
    - 验证第二天自动清理旧数据

### 修改脚本
- 脚本是单个自包含的 JavaScript 文件（约 4500+ 行）
- 所有样式通过 `GM_addStyle` 注入（约 770-1880 行）
- 外部依赖通过 `@require` 加载：
  - Lightweight Charts v4.0.1（图表库）
- 数据结构更改需要同时更新 `Storage.load()` 和 `DEFAULT_DATA` 常量
- 新增功能需要考虑：
  - 数据迁移和向后兼容性
  - UI 面板创建和渲染
  - 事件监听和交互
  - 样式注入

### 代码组织
脚本采用模块化组织（通过对象命名空间），主要模块：
1. **配置与工具** (行 20-166)：CONFIG, Utils, TimeUtils
2. **存储** (行 54-94)：Storage
3. **API** (行 168-274)：API
4. **数据处理** (行 276-536)：DataProcessor
5. **通知** (行 538-722)：Notification
6. **调度** (行 724-769)：Scheduler
7. **样式** (行 772-1882)：Styles
8. **图表** (行 1884-2645)：Chart, ChartManager, MultiPanelManagerClass
9. **UI 面板** (行 2647-3760)：UIPanels
10. **UI 渲染** (行 3762-4262)：UIRenderers
11. **交互** (行 4264-4429)：Interactions
12. **业务入口** (行 4431-4501)：App
13. **启动** (行 4503-4532)：初始化和菜单注册

### 常用开发命令
由于这是单文件项目，开发涉及：
- 直接编辑 `ark-api-stock-monitor.user.js`
- 通过在 Tampermonkey 中重新加载脚本测试更改
- 检查浏览器控制台是否有错误（使用 `console.error()` 进行调试）
- 使用 `console.log("[Ark Stock Monitor] ...")` 格式输出日志

### 版本更新
更新脚本版本时：
1. 更新 UserScript 元数据中的 `@version` 头（行 4）
2. 如果更改存储结构：
   - 更新 `DEFAULT_DATA` 常量（行 26-51）
   - 更新 `Storage.load()` 函数中的数据迁移逻辑（行 58-89）
   - 考虑向后兼容性
3. 测试与现有存储数据的兼容性
4. 提交前确保代码格式一致

### 调试技巧
- 使用浏览器开发者工具的 Console 查看日志
- 所有错误都带有 `[Ark Stock Monitor]` 前缀
- 使用 `Storage.load()` 在控制台查看当前数据
- 使用 `GM_getValue("windhub_stock_data")` 直接访问存储
- 图表调试：检查 `ChartManager.getInstance()` 状态
- 面板调试：检查 `UIPanels._xxxPanel` 是否存在

## 集成点

### Windhub.cc 网站
- 脚本通过 `@match` 指令在以下域名上运行：
  - `https://windhub.cc/*`
  - `https://test-fast.windhub.cc/*`
- 使用 `localStorage.getItem("user")` 进行用户认证
- API 接口（动态 Base URL）：
  - `${baseUrl}/api/user/self/stock/market` - 市场数据（价格、持仓、余额、套利数据）
  - `${baseUrl}/api/user/self/stock/my-trades` - 交易历史
- 请求头要求：
  - `new-api-user`: 用户 ID（从 localStorage 获取）
  - `cookie`: 浏览器 cookies
  - `Referer`: `${baseUrl}/console/model-stock`

### 外部依赖
- **Lightweight Charts v4.0.1**：从 jsDelivr CDN 加载
  - 用途：分时走势图渲染
  - 特性：深色主题、时间序列、标记、价格线
- **Tampermonkey/Violentmonkey API**：
  - `GM_setValue` / `GM_getValue` - 数据持久化
  - `GM_registerMenuCommand` - 注册菜单命令
  - `GM_addStyle` - 注入 CSS 样式
  - `GM_xmlhttpRequest` - Telegram API 请求（跨域）
  - `GM_info` - 获取脚本信息（版本号）
- **Telegram Bot API**（可选）：
  - `https://api.telegram.org/bot{token}/sendMessage`
  - 用途：价格突破推送通知

### 浏览器 API
- `localStorage` - 用户认证信息存储
- `fetch` - 市场和交易数据请求
- `Web Audio API` - 通知声音播放
- `document.cookie` - Cookie 读取
- `window.location.origin` - 动态 Base URL

## 性能考虑

- **数据显示优化**：
  - 价格表格仅显示最近 10 条记录（`CONFIG.TABLE_DISPLAY_LIMIT = 10`）
  - 动态列宽度，根据模型数量自适应
- **数据存储优化**：
  - 价格数据按天自动清理，默认保留最近 7 天（可配置）
  - 每天只清理一次，避免重复操作
  - 清理基于 (N-1) 天前的 0 点时间戳
- **图表性能**：
  - 使用高效的 Lightweight Charts 库（Canvas 渲染）
  - 图表数据按需加载，不预加载所有模型
  - 图表 resize 时使用 requestAnimationFrame 优化
  - 多图表独立管理，互不干扰
- **API 调用优化**：
  - 自动获取遵循分钟尾数触发器，可自定义间隔（如每小时 2 次）
  - 数据缓存机制（5 分钟），减少重复 API 请求
  - 可用模型列表缓存，避免频繁请求
  - 交易历史缓存，按需刷新
- **UI 渲染优化**：
  - 异步加载和渲染，使用 `requestAnimationFrame`
  - 面板懒加载，首次打开时才创建 DOM
  - 事件监听使用事件委托（如套利表格按钮）
  - CSS 动画使用 GPU 加速（transform、opacity）
- **内存管理**：
  - 图表关闭时正确清理实例（`chart.remove()`）
  - Tooltip cleanup 函数在面板关闭时调用
  - Map 数据结构用于高效的面板管理

## 安全注意事项

- **数据安全**：
  - 代码中不包含 API 密钥或敏感凭证
  - 用户认证由浏览器的 localStorage 处理
  - 所有数据通过 Tampermonkey API 本地存储
  - Telegram Token 和 Chat ID 加密存储在本地
- **脚本权限**：
  - 脚本仅在 windhub.cc 和 test-fast.windhub.cc 域名上运行
  - `@grant` 权限最小化，仅使用必要的 GM API
  - `GM_xmlhttpRequest` 仅用于 Telegram API（HTTPS）
- **XSS 防护**：
  - 所有用户输入通过 `Utils.escapeHtml()` 转义
  - 动态生成的 HTML 使用模板字符串，避免注入
  - data 属性使用转义值
- **CORS 处理**：
  - Telegram API 请求通过 `GM_xmlhttpRequest` 绕过 CORS
  - 市场数据请求使用原生 fetch（同源）
- **数据传输**：
  - 所有 API 请求使用 HTTPS
  - Telegram 通知使用 HTTPS 加密传输
  - Cookie 由浏览器自动管理，不手动操作
- **输入验证**：
  - 价格突破限制必须是非负整数
  - 保留天数必须是大于 1 的整数
  - 分钟尾数格式验证（逗号分隔）

## 已知限制与注意事项

1. **单页应用兼容性**：脚本在页面加载时运行，SPA 路由切换不会重新加载
2. **数据同步**：多标签页/浏览器之间数据不自动同步，各自维护独立存储
3. **时区处理**：所有时间显示使用本地时区，不支持自定义时区
4. **图表数据量**：图表渲染的数据点过多（>10000）可能影响性能
5. **Telegram 通知**：
   - 需要用户自行创建 Bot 并获取 Token
   - Chat ID 需要手动获取
   - 通知失败不会重试
6. **浏览器兼容性**：
   - 需要支持 ES6+ 语法（箭头函数、模板字符串等）
   - 需要支持 Web Audio API（声音通知）
   - 需要支持 Fetch API
7. **存储限制**：
   - Tampermonkey 存储空间有限（通常几 MB）
   - 大量历史数据可能超出限制
   - 建议定期清理或减少保留天数
8. **网络依赖**：
   - 需要稳定的网络连接
   - CDN 资源（Lightweight Charts）可能因网络问题加载失败
   - API 请求失败不会自动重试