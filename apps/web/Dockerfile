# @hub/web Next.js 生产镜像（standalone 输出）

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @hub/web...

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY tsconfig.base.json ./
ENV NEXT_TELEMETRY_DISABLED=1
ARG HUB_SITE_URL=https://2api.hub
ARG API_INTERNAL_URL=http://127.0.0.1:8711
ARG HUB_SKIP_API_PRERENDER=1
# 镜像构建时 API 尚未启动，按需渲染公开数据；不生成任何模拟内容。
RUN HUB_SITE_URL=$HUB_SITE_URL API_INTERNAL_URL=$API_INTERNAL_URL HUB_SKIP_API_PRERENDER=$HUB_SKIP_API_PRERENDER pnpm --filter @hub/web build

FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
ENV PORT=3210 HOSTNAME=0.0.0.0
# Next standalone 输出：包含最小 node_modules 与 server.js
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static/
COPY --from=build /repo/apps/web/public ./apps/web/public/
EXPOSE 3210
# standalone server.js 位于 monorepo 路径下
CMD ["node", "apps/web/server.js"]
