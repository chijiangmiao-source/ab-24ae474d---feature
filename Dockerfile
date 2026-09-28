# syntax=docker/dockerfile:1

# ---- 依赖层 ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- 构建层：类型检查 + 产物构建 ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- 验收层：测试 + 构建 + 健康 HTTP 冒烟，以退出码报告 ----
FROM deps AS verify
COPY . .
ENV CI=true
CMD ["sh", "scripts/verify.sh"]

# ---- 运行层：nginx 静态站点，含 /health 健康路径 ----
FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
