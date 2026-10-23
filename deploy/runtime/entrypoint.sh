#!/bin/sh
# 入口（RELEASE.md §2.2）：tini → 本脚本 → supervisor。
# 容器内由 Dockerfile ENTRYPOINT 使用；本地/测试可直接 node deploy/runtime/supervisor.mjs。
set -e
export HUB_IMAGE_VERSION="${HUB_IMAGE_VERSION:-$(cat /app/image-version 2>/dev/null || echo v0.0.0)}"
exec node /app/runtime/supervisor.mjs
