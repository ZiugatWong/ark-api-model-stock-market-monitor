# Stock Data Service

Ark API 模型股票数据服务 - 独立的后端服务，提供价格数据的定时同步和 HTTP API 查询。

## 功能特性

- ✅ 定时自动同步所有模型价格（可配置 Cron 表达式）
- ✅ Redis 持久化存储（AOF + RDB 双保障）
- ✅ 最近 7 天价格历史查询
- ✅ 批量查询多个模型价格
- ✅ IP 限流保护（基于 Redis 存储）
- ✅ Docker 一键部署

## 技术栈

- **Node.js 20+** - 运行时
- **Express** - HTTP 框架
- **ioredis** - Redis 客户端
- **node-cron** - 定时任务
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
# 必填项：WINDHUB_USER_ID, WINDHUB_COOKIE
# 其他配置已在 docker-compose.yml 中设置默认值
```

### 2. 获取认证信息

在浏览器中打开 [windhub.cc](https://windhub.cc)，登录后：

**获取 User ID**（在控制台执行）：

```javascript
JSON.parse(localStorage.getItem("user")).id
```

**获取 Cookie**：网站的会话 Cookie 设置了 `HttpOnly`，无法通过 `document.cookie` 读取，需从实际请求中复制：

1. 打开开发者工具（F12），切换到 **Network（网络）** 面板
2. 刷新页面或在模型股票页面触发一次请求，找到对 `/api/user/self/stock/market` 的请求
3. 在该请求的 **Request Headers（请求标头）** 中找到 `cookie` 字段，复制其完整值

> 提示：也可以在请求上右键选择 “Copy → Copy as cURL”，从命令中提取 `cookie` 的值。

将获取的值填入 `.env` 文件：

```env
WINDHUB_USER_ID=你的用户ID
WINDHUB_COOKIE=你的完整Cookie
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

## API 接口

### POST /api/prices/batch

批量查询多个模型的价格历史

**请求：**
```json
{
  "models": ["gpt-4", "claude-3-opus"],
  "days": 7
}
```

**响应：**
```json
{
  "success": true,
  "data": {
    "gpt-4": [
      {"timestamp": 1718380800, "price": 99.50},
      {"timestamp": 1718384400, "price": 99.75}
    ],
    "claude-3-opus": [
      {"timestamp": 1718380800, "price": 45.25}
    ]
  }
}
```

### GET /api/models

获取所有可用模型列表

**响应：**
```json
{
  "success": true,
  "data": {
    "models": ["gpt-4", "claude-3-opus", "gemini-pro"],
    "count": 3
  }
}
```

### POST /api/sync

手动触发同步（用于测试）

**响应：**
```json
{
  "success": true,
  "message": "同步任务已触发"
}
```

## 配置说明

### 环境变量

**必填项（需在 .env 文件中或 docker-compose.yml 中配置）：**

| 变量名            | 说明            | 必填 |
| ----------------- | --------------- | ---- |
| `WINDHUB_USER_ID` | Windhub 用户 ID | ✅    |
| `WINDHUB_COOKIE`  | 浏览器 Cookie   | ✅    |

**可选项（已在 docker-compose.yml 中设置默认值）：**

| 变量名                      | 说明                 | 默认值                                   |
| --------------------------- | -------------------- | ---------------------------------------- |
| `WINDHUB_BASE_URL`          | API 基础 URL         | `https://windhub.cc`                     |
| `SYNC_CRON`                 | 同步任务 Cron 表达式 | `*/5 * * * *`（每5分钟）                 |
| `REDIS_URL`                 | Redis 连接 URL       | `redis://ark-api-model-stock-redis:6379` |
| `RATE_LIMIT_WINDOW_SECONDS` | 限流窗口（秒）       | `60`                                     |
| `RATE_LIMIT_MAX`            | 窗口内最大请求数     | `3`                                      |
| `PORT`                      | 服务端口             | `3210`                                   |
| `EXPRESS_TRUST_PROXY`       | Express Trust Proxy  | `false`                                  |

> **修改配置**：如需自定义可选配置，请直接修改 `docker-compose.yml` 文件中的对应值。

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
- Key: `price:{modelName}`
- Score: 时间戳（秒）
- Member: `{timestamp}:{price}`
- TTL: 8天

**模型列表（Set）：**
- Key: `models:all`
- TTL: 1小时

**限流计数器（基于 Redis）：**
- Key: `ratelimit:{ip}`
- TTL: 动态（根据窗口大小）

## 验证测试

```bash
# 获取模型列表
curl http://localhost:3210/api/models

# 批量查询价格
curl -X POST http://localhost:3210/api/prices/batch \
  -H "Content-Type: application/json" \
  -d '{"models":["gpt-4","claude-3-opus"],"days":7}'

# 手动触发同步
curl -X POST http://localhost:3210/api/sync

# 限流测试（快速连续5次请求，应触发限流）
for i in {1..5}; do curl http://localhost:3210/api/models & done
```

### Redis 数据验证

```bash
# 进入 Redis CLI
docker exec -it ark-api-model-stock-redis redis-cli

# 查看所有模型
SMEMBERS models:all

# 查看某个模型的价格数据
ZRANGE price:gpt-4 0 -1 WITHSCORES

# 查看数据量
ZCARD price:gpt-4

# 验证 TTL
TTL price:gpt-4
```

## 项目结构

```
stock-data-service/
├── src/
│   ├── config/
│   │   ├── env.js              # 环境变量配置
│   │   └── redis.js            # Redis 连接
│   ├── services/
│   │   ├── windhubApi.js       # Windhub API 封装
│   │   ├── priceStorage.js     # 价格数据存储
│   │   └── syncScheduler.js    # 定时同步任务
│   ├── middleware/
│   │   └── rateLimit.js        # 限流中间件
│   ├── routes/
│   │   └── api.js              # HTTP 路由
│   └── app.js                  # 应用入口
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

1. **Cookie 安全**：Cookie 包含敏感信息，不要提交到代码仓库
2. **时间戳格式**：API 返回的 `last_update` 是秒级时间戳
3. **数据清理**：每次同步时自动清理 7 天前的数据
4. **持久化**：Redis 使用 AOF + RDB 双持久化，最多丢失 1 秒数据
5. **限流策略**：默认 1 分钟 3 次，基于 Redis 存储实现分布式限流
6. **CORS 跨域**：默认允许所有域名访问（`Access-Control-Allow-Origin: *`）
7. **Trust Proxy**：如果服务运行在反向代理（如 Nginx、Cloudflare）后面，建议设置 `EXPRESS_TRUST_PROXY=true` 以正确获取客户端真实 IP（用于限流）

## 故障排查

### Redis 连接失败
```bash
# 检查 Redis 容器状态
docker compose ps ark-api-model-stock-redis

# 查看 Redis 日志
docker compose logs ark-api-model-stock-redis
```

### 同步失败
```bash
# 查看应用日志
docker compose logs ark-api-model-stock-service

# 检查环境变量是否正确
docker compose exec ark-api-model-stock-service env | grep WINDHUB
```

### 数据未更新
```bash
# 手动触发同步
curl -X POST http://localhost:3210/api/sync

# 检查 Cron 表达式是否有效
# 查看应用日志中的 [定时任务] 相关信息
```
