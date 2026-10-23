#!/usr/bin/env bash
# 本地构建生产镜像：先 release:build 再 docker build。
# 用法：scripts/release/docker-build.sh <tag> [image-name]
#   tag：如 v0.1.0（必须与 dist/release/<tag> 一致）
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${1:?用法: docker-build.sh <tag> [image-name]}"
IMAGE="${2:-ghcr.io/fluxcode666/2api-hub}"

# 发布包不存在时先构建
if [ ! -f "dist/release/${TAG}/release.json" ]; then
  echo "[docker-build] dist/release/${TAG} 不存在，先执行 release:build"
  pnpm release:build --tag "${TAG}"
fi

REGISTRY_ARG=()
if [ -n "${NODE_IMAGE_REGISTRY:-}" ]; then
  # 本地网络受限时用镜像源（如 docker.m.daocloud.io/library）；CI 默认 docker.io
  REGISTRY_ARG=(--build-arg NODE_IMAGE_REGISTRY="${NODE_IMAGE_REGISTRY}")
fi

echo "[docker-build] 构建镜像 ${IMAGE}:${TAG}"
docker build \
  --build-arg RELEASE_TAG="${TAG}" \
  --build-arg RELEASE_DIR=dist/release \
  "${REGISTRY_ARG[@]}" \
  --label org.opencontainers.image.source=https://github.com/FluxCode666/2api-hub \
  --label org.opencontainers.image.version="${TAG}" \
  -t "${IMAGE}:${TAG}" .
echo "[docker-build] 完成：${IMAGE}:${TAG}"
