# @hub/api 生产镜像（pnpm monorepo + tsx 运行 TS 源码）

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /repo

# ---- 裁剪依赖（只装 api 及其 workspace 依赖，含 tsx） ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/probe/package.json packages/probe/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @hub/api...

# ---- 拷贝源码 ----
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/probe packages/probe
COPY apps/api apps/api
COPY tsconfig.base.json ./

# ---- 运行 ----
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /repo
ENV NODE_ENV=production
# 容器内必须监听 0.0.0.0（其他容器/宿主机才能访问）
ENV API_HOST=0.0.0.0
COPY --from=build /repo /repo
EXPOSE 8711
# tsx 直接跑 TS（tsx 在 api 的 devDependencies，install 已装）
CMD ["./node_modules/.bin/tsx", "apps/api/src/index.ts"]
