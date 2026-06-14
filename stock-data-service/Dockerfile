FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制源码
COPY src/ ./src/

# 暴露端口
EXPOSE 3210

# 启动服务
CMD ["node", "src/app.js"]
