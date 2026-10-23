# 2API Hub 生产镜像（RELEASE.md §2）：
# - node:22-alpine + tini（PID 1 → supervisor）
# - 非 root 用户运行；/app/data 为 VOLUME
# - /app/bundle/<tag> 从 CI 构建好的 dist/release/<tag> 复制（不在 Docker 内重新构建，纯 JS 多架构只需复制）

# 基础镜像 registry 可覆盖（本地网络受限时用镜像源：--build-arg NODE_IMAGE_REGISTRY=docker.m.daocloud.io/library）
ARG NODE_IMAGE_REGISTRY=docker.io/library
FROM ${NODE_IMAGE_REGISTRY}/node:22-alpine

# tini：正确转发信号与回收僵尸进程
RUN apk add --no-cache tini

# 构建参数：版本与发布包位置（CI/本地脚本传入）
ARG RELEASE_TAG
ARG RELEASE_DIR=dist/release

# 运行用户（非 root）
RUN addgroup -S hub && adduser -S hub -G hub

WORKDIR /app

# 运行时（supervisor + entrypoint，随镜像升级）
COPY --chown=hub:hub deploy/runtime/supervisor.mjs /app/runtime/supervisor.mjs
COPY --chown=hub:hub deploy/runtime/entrypoint.sh /app/runtime/entrypoint.sh
RUN chmod +x /app/runtime/entrypoint.sh

# 镜像自带发布包（CI 已在镜像外构建好；纯 JS，与架构无关）
COPY --chown=hub:hub ${RELEASE_DIR}/${RELEASE_TAG} /app/bundle/${RELEASE_TAG}
RUN echo "${RELEASE_TAG}" > /app/image-version && chown hub:hub /app/image-version

# 数据卷（站内热更新写这里）；属主为运行用户
RUN mkdir -p /app/data && chown -R hub:hub /app/data
VOLUME /app/data

# 环境变量（业务在运行时读；数据库连接等由部署方提供）
ENV NODE_ENV=production \
    HUB_IMAGE_VERSION=${RELEASE_TAG}

USER hub
EXPOSE 3210

# 健康检查：web 首页与 API healthz（api 只监听容器内 127.0.0.1，从容器内 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3210/ && wget -q -O /dev/null http://127.0.0.1:8711/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/runtime/entrypoint.sh"]
