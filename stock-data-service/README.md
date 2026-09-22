# Stock Data Service

Ark 模型股票数据服务 - 独立的后端服务，提供价格数据的定时同步和 HTTP API 查询。

对接站点：[game.arkengine.me](https://game.arkengine.me)（原股市功能已从 windhub.cc 迁移到此站点）。

## 功能特性

- ✅ 定时自动同步所有活跃模型价格（可配置 Cron 表达式）
- ✅ Redis 持久化存储（AOF + RDB 双保障）
- ✅ 最近 7 天价格历史查询
- ✅ 批量查询多个模型价格
- ✅ Dashboard 可视化页面（同源托管，访问 `/dashboard`）：模型走势卡片网格 + 点击进入 Lightweight Charts 大图详情，新野兽派设计，明暗双主题，响应式适配桌面与移动端
- ✅ GET /api/models 模型列表（带缓存与上游故障兜底降级）
- ✅ 响应 gzip 压缩（compression）
- ✅ IP 限流保护（基于 Redis 存储）
- ✅ Telegram 失败通知（连续 3 次 API 失败告警）
- ✅ Docker 一键部署

## 技术栈

- **Node.js 20+** - 运行时
- **Express** - HTTP 框架
- **ioredis** - Redis 客户端
- **cron** - 定时任务
- **express-rate-limit + rate-limit-redis** - 基于 Redis 的分布式限流
- **axios** - HTTP 请求
- **dotenv** - 环境变量管理
- **Docker Compose** - 容器编排

## 快速开始

### 1. 环境准备

```bash
cd stock-data-service

# 复制环境变量配置
cp .env.example .env

# 编辑 .env 文件，填入真实的认证信息
# 必填项：ARK_GAME_COOKIE
# 其他配置已在 docker-compose.yml 中设置默认值
```

### 2. 获取认证信息

在浏览器中打开 [game.arkengine.me](https://game.arkengine.me)，登录后：

**获取 Cookie**：网站的会话 Cookie 设置了 `HttpOnly`，无法通过 `document.cookie` 读取，需从实际请求中复制：

1. 打开开发者工具（F12），切换到 **Network（网络）** 面板
2. 刷新页面或在模型股票页面触发一次请求，找到对 `/api/stock` 的请求
3. 在该请求的 **Request Headers（请求标头）** 中找到 `cookie` 字段，复制其完整值（通常包含 `ptd_session`）

> 提示：也可以在请求上右键选择 “Copy → Copy as cURL”，从命令中提取 `cookie` 的值。

将获取的值填入 `.env` 文件：

```env
ARK_GAME_COOKIE=你的完整Cookie
```

### 3. Docker 部署（推荐）

```bash
# 构建并启动服务
docker compose up -d

# 查看日志
docker compose logs -f ark-api-model-stock-service

# 查看容器状态
docker compose ps

# 停止服务
docker compose down

# 停止并删除数据
docker compose down -v
```

## Dashboard 页面

浏览器访问 `http://localhost:3210/dashboard` 即可打开 dashboard：

- **网格总览**：每个模型一张走势卡片（名称、停滞徽章、现价、最新涨跌幅、SVG 迷你走势线），响应式网格（移动端 1 列 → 桌面最多 4 列）
- **大图详情**：点击卡片进入，Lightweight Charts v4 大图 + 十字线 tooltip，支持 1 天 / 3 天 / 7 天 / 全部 时间范围切换（纯客户端切片），底部显示区间最高/最低/采样点数
- **主题**：新野兽派风格，明暗双主题，右上角按钮切换；默认跟随系统偏好，手动切换后持久化到 localStorage
- **自动刷新**：每 5 分钟（与同步周期一致），支持手动刷新；页面切回前台时超期自动补拉

## API 接口

### GET /api/models

dashboard 模型列表（不限流）。

数据来源：上游行情 `stocks[]`（id/modelName/stale/priceCents），Redis 两级缓存——主缓存 `stock_models:all`（TTL 5 分钟，定时同步时顺带预热）；上游拉取失败时降级返回兜底缓存 `stock_models:lastgood`（TTL 24 小时）并在响应中标记 `staleCache: true`；两级均缺失时返回 500。

**响应：**
```json
{
  "success": true,
  "data": {
    "models": [
      {"id": 2239, "name": "gpt-5", "stale": false, "price": 99.5}
    ],
    "count": 17,
    "cachedAt": 1758350000
  }
}
```

字段说明：`stale` 为 `true` 表示行情停滞（无 tick）；`price` 为现价（代币，2 位小数）；`cachedAt` 为缓存写入时间（秒）；`staleCache` 仅在返回兜底缓存时出现。

### GET /api/manual

dashboard 说明（不限流）。内容来自服务根目录的 `manual.md`（Markdown 编写，服务端转为 HTML 返回）：文件不存在或解析失败返回空字符串（前端显示「暂无说明」）；带 mtime 缓存，修改文件后无需重启服务即可生效。Docker 部署时该文件以只读卷挂载进容器，直接编辑宿主机上的 `manual.md` 即可。

**响应：**
```json
{
  "success": true,
  "data": {
    "content": "<h1>说明</h1>\n<ul>\n<li>示例条目</li>\n</ul>"
  }
}
```

### POST /api/prices/batch

批量查询多个模型的价格历史（主键为 stockId，不限流，供 dashboard 页面调用）。

**请求：**
```json
{
  "stockIds": [1, 2, 5],
  "days": 7
}
```

**响应：**
```json
{
  "success": true,
  "data": {
    "1": [
      {"timestamp": 1718380800, "price": 99.50},
      {"timestamp": 1718384400, "price": 99.75}
    ],
    "2": [
      {"timestamp": 1718380800, "price": 45.25}
    ]
  }
}
```

### GET /api/stock-ids

获取所有可用 stockId 列表

**响应：**
```json
{
  "success": true,
  "data": {
    "stockIds": [1, 2, 3, 5, 8],
    "count": 5
  }
}
```

### POST /api/sync

手动触发同步（用于测试）

**响应：**
```json
{
  "success": true,
  "data": { "message": "同步任务已触发" }
}
```

### POST /api/backfill

手动触发补漏（无请求体）。全量检查从行情 API 返回的所有模型的缺失数据：把 `ticks` 按「模型连续不重复」还原成多批，每批过滤掉与批内最大时间戳差超 5 分钟的旧数据、并把该批时间戳统一为批内最大时间戳（与定时同步一致的归一化规则），只把这些缺失时间戳补回 Redis、不覆盖已有数据。**服务启动时也会自动执行一次补漏**，结果写入服务日志。

**响应：**
```json
{
  "success": true,
  "data": {
    "modelCount": 3,
    "perModel": {
      "2239": 3,
      "12202": 2
    }
  }
}
```

## 配置说明

### 环境变量

**必填项（需在 .env 文件中或 docker-compose.yml 中配置）：**

| 变量名            | 说明                          | 必填 |
| ----------------- | ----------------------------- | ---- |
| `ARK_GAME_COOKIE` | game.arkengine.me 会话 Cookie | ✅    |

**可选项（已在 docker-compose.yml 中设置默认值）：**

| 变量名                      | 说明                 | 默认值                                   |
| --------------------------- | -------------------- | ---------------------------------------- |
| `ARK_GAME_BASE_URL`         | API 基础 URL         | `https://game.arkengine.me`              |
| `ARK_GAME_API_TIMEOUT`      | API 请求超时（毫秒） | `15000`                                  |
| `ARK_GAME_API_RETRIES`      | API 请求重试次数     | `3`                                      |
| `ARK_GAME_API_RETRY_DELAY`  | 重试间隔（毫秒）     | `2000`                                   |
| `SYNC_CRON`                 | 同步任务 Cron 表达式 | `1/5 * * * *`（每5分钟）                 |
| `REDIS_URL`                 | Redis 连接 URL       | `redis://ark-api-model-stock-redis:6379` |
| `RATE_LIMIT_WINDOW_SECONDS` | 限流窗口（秒）       | `60`                                     |
| `RATE_LIMIT_MAX`            | 窗口内最大请求数     | `2`                                      |
| `PORT`                      | 服务端口             | `3210`                                   |
| `EXPRESS_TRUST_PROXY`       | Express Trust Proxy  | `false`                                  |

**通知配置（可选）：**

| 变量名                             | 说明                                 | 默认值           |
| ---------------------------------- | ------------------------------------ | ---------------- |
| `ARK_GAME_API_FAILED_NOTIFICATION` | 通知渠道，设置为 `telegram` 启用通知 | 空（不发送通知） |
| `TELEGRAM_BOT_TOKEN`               | Telegram Bot Token                   | 空               |
| `TELEGRAM_CHAT_ID`                 | Telegram Chat ID                     | 空               |

> **修改配置**：如需自定义可选配置，请直接修改 `docker-compose.yml` 文件中的对应值。

**Dashboard 说明（非环境变量）：** 说明弹窗内容来自服务根目录的 `manual.md`（Markdown），详见 `GET /api/manual` 接口说明。本地/源码部署直接编辑该文件即可（mtime 缓存，改完即生效）；Docker 部署时该文件以只读卷挂载进容器，同样直接编辑、无需重启。

### Cron 表达式示例

```
*/5 * * * *   # 每5分钟
*/10 * * * *  # 每10分钟
0 * * * *     # 每小时
0 0 * * *     # 每天0点
```

## 数据结构

### Redis 数据

**价格数据（Sorted Set）：**
- Key: `price:{stockId}`
- Score: 时间戳（秒，已归一化为本轮 maxTimestamp）
- Member: `{timestamp}:{price}`
- TTL: 8天

**stockId 列表（Set）：**
- Key: `stock_ids:all`
- TTL: 1小时

**dashboard 模型列表（String）：**
- Key: `stock_models:all` - 主缓存（值含 models/count/cachedAt）
- TTL: 5分钟（定时同步时顺带预热）
- Key: `stock_models:lastgood` - 上游故障兜底缓存（最后可用快照）
- TTL: 24小时

**限流计数器（基于 Redis）：**
- Key: `ratelimit:{ip}` - 严格限流（/api/models、/api/prices/batch 与 /health 除外）
- TTL: 动态（根据窗口大小）

**失败通知计数器：**
- Key: `ark_game:api:failure:count` - 失败次数（TTL: 1小时）
- Key: `ark_game:api:failure:last_error` - 最后错误详情（TTL: 1小时）
- Key: `ark_game:api:notification:cooldown` - 通知冷却期（TTL: 30分钟）

## 升级注意事项（从旧版本升级时必读）

> ⚠️ **如果之前部署过旧版本（对接 windhub.cc 的服务），第一次部署新版本时，有数据洁癖的可以手动清空 Redis 残留数据。**

新版本的数据主键将从 `modelName` 切换为 `stockId`，Redis 中可能残留旧版本的 `models:all` 与 `price:{modelName}` 等键，这些旧键会因 TTL 自动过期（价格 8 天、模型列表 1 小时）

```bash
# 想手动清理的话直接清空整个 Redis
docker exec -it ark-api-model-stock-redis redis-cli FLUSHDB
```

## 失败通知配置

当数据服务连续 3 次调用 Ark Game API 失败后，可自动通过 Telegram 发送告警通知。

### 1. 创建 Telegram Bot

1. 在 Telegram 中搜索 `@BotFather`
2. 发送 `/newbot` 创建新机器人
3. 按提示设置机器人名称和用户名
4. 获得 `Bot Token`（格式：`123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`）

### 2. 获取 Chat ID

**方法 1 - 使用 API（推荐）：**
```bash
# 1. 先给你的 Bot 发送任意消息
# 2. 访问以下 URL（替换 <YOUR_BOT_TOKEN>）
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates

# 3. 在返回的 JSON 中找到 "chat":{"id":123456789}
```

**方法 2 - 使用 @userinfobot：**
1. 搜索并启动 @userinfobot
2. 发送任意消息给它
3. 它会返回你的 Chat ID

### 3. 配置环境变量

编辑 `.env` 文件，添加以下配置：

```bash
# 启用 Telegram 通知
ARK_GAME_API_FAILED_NOTIFICATION=telegram

# Telegram 凭证
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=123456789
```

### 4. 通知触发条件

- ✅ 连续失败 3 次才发送通知
- ✅ 发送通知后进入 30 分钟冷却期（避免通知轰炸）
- ✅ 同步成功后自动重置失败计数器
- ✅ 长时间未同步（1 小时）后计数器自动过期

### 5. 通知消息示例

```
⚠️ Ark Game API 连续失败告警

失败次数: 3 次
最后失败时间: 2026-08-20 14:30:00
失败原因: API请求失败: 401 - Unauthorized

请检查 ARK_GAME_COOKIE 是否过期。
```

### 6. 禁用通知

如不需要通知功能，在 `.env` 中删除或注释相关配置：

```bash
# ARK_GAME_API_FAILED_NOTIFICATION=telegram
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
```

## 验证测试

```bash
# 获取 stockId 列表
curl http://localhost:3210/api/stock-ids

# 批量查询价格（主键 stockId）
curl -X POST http://localhost:3210/api/prices/batch \
  -H "Content-Type: application/json" \
  -d '{"stockIds":[1,2],"days":7}'

# dashboard 模型列表
curl http://localhost:3210/api/models

# dashboard 页面
curl -I http://localhost:3210/dashboard

# 手动触发同步
curl -X POST http://localhost:3210/api/sync

# 限流测试（快速连续5次请求，应触发严格限流）
for i in {1..5}; do curl http://localhost:3210/api/stock-ids & done

# dashboard 数据端点不限流（35 次请求应全部 200）
for i in $(seq 1 35); do curl -s -o /dev/null -w "%{http_code} " http://localhost:3210/api/models; done; echo
```

### Redis 数据验证

```bash
# 进入 Redis CLI
docker exec -it ark-api-model-stock-redis redis-cli

# 查看所有活跃 stockId
SMEMBERS stock_ids:all

# 查看某个 stockId 的价格数据（假设 stockId=1）
ZRANGE price:1 0 -1 WITHSCORES

# 查看数据量
ZCARD price:1

# 验证 TTL
TTL price:1
```

## 项目结构

```
stock-data-service/
├── src/
│   ├── config/
│   │   ├── env.js              # 环境变量配置
│   │   └── redis.js            # Redis 连接
│   ├── constants/
│   │   ├── business.js         # 业务常量（数据保留期、缓存 TTL）
│   │   └── redisKeys.js        # Redis 键名常量
│   ├── services/
│   │   ├── arkGameApi.js       # Ark Game API 封装
│   │   ├── priceStorage.js     # 价格数据存储
│   │   ├── modelsService.js    # dashboard 模型列表（缓存/上游拉取/兜底降级）
│   │   ├── syncScheduler.js    # 定时同步任务
│   │   └── notificationService.js  # 通知服务
│   ├── middleware/
│   │   └── rateLimit.js        # 双档限流（严格 + dashboard 宽松）
│   ├── routes/
│   │   └── api.js              # HTTP 路由
│   ├── utils/
│   │   ├── logger.js           # 日志工具
│   │   ├── responseHelper.js   # API 响应助手
│   │   └── timeUtils.js        # 时间工具
│   └── app.js                  # 应用入口
├── public/                     # dashboard 静态页面（无构建，经 /dashboard 前缀托管）
│   └── dashboard/
│       ├── index.html
│       ├── style.css
│       └── app.js
├── Dockerfile
├── docker-compose.yml
├── redis.conf                  # Redis 持久化配置
├── .env.example
├── .dockerignore
├── .gitignore
├── package.json
└── README.md
```

## 注意事项

1. **Cookie 安全**：Cookie 包含敏感信息，不要提交到代码仓库（`.env` 已在 `.gitignore` 中）
2. **时间戳格式**：价格数据的时间戳为秒级，已归一化为本轮 `maxTimestamp`
3. **数据清理**：每次同步时自动清理 7 天前的数据
4. **持久化**：Redis 使用 AOF + RDB 双持久化，最多丢失 1 秒数据
5. **限流策略**：默认 1 分钟 2 次，基于 Redis 存储实现分布式限流
6. **CORS 跨域**：默认允许所有域名访问（`Access-Control-Allow-Origin: *`）
7. **Trust Proxy**：如果服务运行在反向代理（如 Nginx、Cloudflare）后面，建议设置 `EXPRESS_TRUST_PROXY=true` 以正确获取客户端真实 IP（用于限流）
8. **主键**：全部使用 stockId（数字），不用 modelName
9. **前端图表库**：Lightweight Charts v4.0.1 通过 jsDelivr CDN 引入（`index.html`），升级直接改引用地址的版本号
10. **限流策略**：单档限流（默认 60 秒 2~3 次），dashboard 数据端点（/api/models、/api/prices/batch）与健康检查由 skip 跳过、不限流

## 故障排查

### Redis 连接失败
```bash
# 检查 Redis 容器状态
docker compose ps ark-api-model-stock-redis

# 查看 Redis 日志
docker compose logs ark-api-model-stock-redis
```

### 同步失败

当出现 `API请求无响应` 错误时，通常是网络抖动或服务端偶发超时导致。数据服务已内置重试机制：

- 请求超时后自动重试，最多重试 3 次（由 `ARK_GAME_API_RETRIES` 控制）
- 每次重试间隔 2 秒（由 `ARK_GAME_API_RETRY_DELAY` 控制）
- 仅对可恢复的网络错误重试（超时、连接重置、DNS 失败等），服务端返回 4xx/5xx 不会重试
- 重试耗尽后仍失败才会记录为同步失败

如果频繁出现同步失败，可尝试增大超时和重试参数：

```env
ARK_GAME_API_TIMEOUT=20000
ARK_GAME_API_RETRIES=5
ARK_GAME_API_RETRY_DELAY=3000
```

```bash
# 查看应用日志，确认重试情况
docker compose logs ark-api-model-stock-service

# 检查环境变量是否正确
docker compose exec ark-api-model-stock-service env | grep ARK_GAME
```

### 数据未更新
```bash
# 手动触发同步
curl -X POST http://localhost:3210/api/sync

# 检查 Cron 表达式是否有效
# 查看应用日志中的 [定时同步] 相关信息
```

### 通知未收到
```bash
# 1. 检查环境变量是否生效
docker exec -it ark-api-model-stock-service printenv | grep TELEGRAM

# 2. 查看服务日志
docker logs -f ark-api-model-stock-service

# 3. 检查 Redis 失败计数器
docker exec -it ark-api-model-stock-redis redis-cli GET ark_game:api:failure:count

# 4. 检查冷却期状态
docker exec -it ark-api-model-stock-redis redis-cli EXISTS ark_game:api:notification:cooldown
```

**可能原因：**
- 失败次数未达到 3 次
- 正在冷却期内（30 分钟内已发送过通知）
- 环境变量配置错误
- Bot Token 或 Chat ID 不正确
- 网络问题无法访问 Telegram API
