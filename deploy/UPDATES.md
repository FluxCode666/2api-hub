# 2API Hub 站内热更新操作手册

> 参考 AUXUM 的「tag 发版 + 管理员在后台主动原地更新」模式。
> 本文面向运维/管理员，描述首次安装、日常更新、失败回退的完整流程。

## 首次安装

### 1. 准备服务器

```bash
# 安装 Docker 与 docker compose 插件（略）
# 创建部署目录
mkdir -p /root/2api-hub && cd /root/2api-hub
```

### 2. 配置环境变量

```bash
# 复制模板并填写（密钥用 openssl rand -hex 32 生成）
cp deploy/prod.env.example .env
chmod 600 .env
# 编辑 .env，必填：POSTGRES_PASSWORD / APP_ENCRYPTION_KEY / SESSION_SECRET
# 可选：INIT_ADMIN_EMAIL + INIT_ADMIN_PASSWORD（首次启动创建管理员，≥12 位）
```

### 3. 启动

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d
# 查看日志
docker logs -f 2api-hub-app
```

首次启动会自动执行：drizzle 迁移 → 写入厂商/模型目录 → 补默认 settings → 创建管理员（如果提供了 INIT_ADMIN_*）。

### 4. 验证

```bash
curl http://127.0.0.1:3210/api/v1/healthz
# {"ok":true,"version":"v0.1.0"}
```

## 站内更新（推荐）

管理员登录后台 → 侧边栏顶部版本徽章 → 「系统版本」对话框：

1. 点击「检查更新」查询 GitHub 最新 Release（缓存 10 分钟）。
2. 有新版本时显示「更新到 vX.Y.Z」按钮（二次确认，提醒先备份数据库）。
3. 更新过程自动执行：检查 → 下载 → 校验 SHA-256 → 解压 → 切换 → 重启。
4. 重启期间页面会短暂不可用，前端会自动轮询直到新版本就绪。

**更新失败会自动回退**到上一个版本，无需人工干预。

## 手动镜像升级

```bash
# 修改 .env 中的 HUB_IMAGE_TAG 为新版本
vim .env
# 重新拉取并重启
docker compose -f deploy/docker-compose.prod.yml --env-file .env pull
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d
```

镜像升级会保留站内更新出的更高版本（取 `max(镜像版本, 站内更新版本)`）。

## 回退

- **自动回退**：新版本启动失败（60s 内 healthz 未就绪）会自动回退到 `previous` 版本。
- **手动回退**：管理后台「系统版本」对话框 → 「回退到 vX」（存在 `previousVersion` 时可用）。

## 备份建议

- 数据库：`docker exec 2api-hub-postgres pg_dump -U hub hub > backup-$(date +%F).sql`
- 数据卷：`/app/data` 包含所有已安装的发布包和更新任务状态，建议定期备份。

## 注意事项

- 更新前建议先备份数据库（更新对话框会提醒）。
- 预发布版本（如 `v0.2.0-rc.1`）不参与站内更新。
- 更新下载上限 200MB，SHA-256 校验失败会自动中止。
- 只保留最近 3 个版本，旧版本自动清理。
