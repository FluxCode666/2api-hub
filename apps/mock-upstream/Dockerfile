# @hub/mock-upstream 模拟上游镜像

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/mock-upstream/package.json apps/mock-upstream/
RUN pnpm install --frozen-lockfile --filter @hub/mock-upstream

FROM deps AS build
COPY apps/mock-upstream apps/mock-upstream
COPY tsconfig.base.json ./

FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 8712
CMD ["./node_modules/.bin/tsx", "apps/mock-upstream/src/index.ts"]
