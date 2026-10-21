# @hub/worker 探测调度器镜像（GLM 实现）

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/probe/package.json packages/probe/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @hub/worker...

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/probe packages/probe
COPY apps/worker apps/worker
COPY tsconfig.base.json ./

FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 8713
CMD ["./node_modules/.bin/tsx", "apps/worker/src/index.ts"]
