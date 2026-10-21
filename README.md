# 2API Hub — AI 中转站聚合导航

聚合所有 AI API 中转站（new-api / sub2api / one-api / 自研站）的导航与比价平台。

- **散户**：按模型或厂商比较各中转站渠道的实际倍率/价格、可用率、延迟、模型真伪可信分，挑选合适渠道后跳转购买。
- **站长**：入驻平台，登记站点与渠道，提交检测用 API Key；平台做模型检测（真伪/一致性/降智）和稳定性探测，审核通过后上榜。
- **管理员**：审核入驻、维护模型/厂商目录、查看探测日志、处理反馈、配置参数。

## 架构

```mermaid
graph TB
  subgraph 浏览器
    U[散户 / 站长 / 管理员]
  end

  subgraph 前端
    W[web<br/>Next.js 16 App Router<br/>:3210]
  end

  subgraph 后端
    A[api<br/>Fastify 5 + zod<br/>:8711]
    K[worker<br/>探测调度 + 统计聚合<br/>:8713 healthz]
  end

  subgraph 数据
    PG[(PostgreSQL 16<br/>:54329)]
  end

  subgraph 检测
    P[@hub/probe<br/>协议适配 / 可用性 / 真伪检测]
    M[mock-upstream<br/>模拟中转站 :8712<br/>仅开发/演示]
  end

  U -->|/api/v1/* 经 Next rewrites| W
  W -->|SSR API_INTERNAL_URL| A
  A --> PG
  K --> PG
  A -->|同步连接测试 / 鉴定| P
  K -->|定时探测 / 真伪任务| P
  P --> M
  P -->|生产| UP[真实中转站上游]
```

## 目录结构

```
2api-hub/
├── apps/
│   ├── web/            # @hub/web        Next.js + Tailwind v4（公开站 + 站长后台 + 管理后台）
│   ├── api/            # @hub/api        Fastify 5 + zod + Drizzle REST API
│   ├── worker/         # @hub/worker     探测调度器 + 统计聚合
│   └── mock-upstream/  # @hub/mock-upstream 模拟上游（OpenAI/Anthropic/Gemini 协议，可配置真/假/抖动）
├── packages/
│   ├── db/             # @hub/db         Drizzle schema + migrations + seed
│   ├── shared/         # @hub/shared     常量、API 契约类型（前后端共用）
│   └── probe/          # @hub/probe      检测引擎库（协议适配、SSRF 防护）
├── deploy/             # 生产部署（docker-compose.prod.yml + 环境模板）
├── docs/SPEC.md        # 产品与技术规格（唯一契约）
└── docker-compose.yml  # 本地 postgres
```

## 本地开发快速开始

前置：Node 22+、pnpm 10、Docker。

```bash
# 1. 安装依赖
pnpm install

# 2. 初始化数据库（起 postgres → 等待健康 → 迁移 → 种子）
pnpm setup:local

# 3. 一键启动全部服务（mock-upstream / api / worker / web）
pnpm dev
```

单独启动：

```bash
pnpm dev:mock    # 模拟上游 :8712
pnpm dev:api     # API :8711
pnpm dev:worker  # 探测调度器 :8713
pnpm dev:web     # 前端 :3210
```

数据库操作：

```bash
pnpm db:up        # 起 postgres（docker）
pnpm db:generate  # schema 变更后生成迁移
pnpm db:migrate   # 执行迁移
pnpm db:seed      # 种子数据（幂等，可重复）
```

## 演示账号

| 角色 | 邮箱 | 密码 |
| --- | --- | --- |
| 管理员 | admin@2api.hub | admin123456 |
| 站长 | merchant@2api.hub | merchant123456 |
| 用户 | user@2api.hub | user123456 |

## 端口

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| web | 3210 | 前端（浏览器访问入口，/api/v1 由 Next rewrites 代理到 api） |
| api | 8711 | REST API |
| mock-upstream | 8712 | 模拟中转站上游（仅开发/演示） |
| worker | 8713 | 探测调度器健康检查 |
| postgres | 54329 | 数据库 |

## 生产部署

```bash
# 1. 准备环境变量
cp deploy/prod.env.example deploy/.env.prod
# 编辑 .env.prod，必填：POSTGRES_PASSWORD / APP_ENCRYPTION_KEY / SESSION_SECRET
# 密钥生成：openssl rand -hex 32

# 2. 构建并启动（自动执行数据库迁移）
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build

# 3. （可选）演示模式附带 mock-upstream
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod --profile demo up -d
```

**前置要求**：`apps/web/next.config.ts` 需要 `output: 'standalone'`（由前端负责人添加）。

## 检测与评分机制

- **可用性探测**：每 10 分钟一次（可配），记录 TTFT / 延迟 / 成功率。
- **真伪检测**：8 项检查（连通性、模型名回显、协议特征、Token 计数、知识与身份、推理能力、能力特征、输出速度），加权得分 → genuine / suspect / fake / unknown。
- **推荐分**：可用率 45% + 延迟 20% + 可信 25% + 稳定性 10%。

详见 [docs/SPEC.md](docs/SPEC.md) §5。

## 限流与并发

- **`/verify` 公开鉴定**：单 IP 每小时额度（默认 10 次，管理后台可调）+ 单 IP 并发上限 1 + 进程级全局并发上限 4。全局上限是**进程级**内存计数，多实例部署时按实例数叠加（如需严格全局上限，需共享令牌存储）。
- **站长手动真伪检测**：每渠道每日额度（默认 3 次），原子入队（渠道行锁 + 复用活动任务 + 唯一索引兜底）。超额度时 PATCH 配置照常保存但不入队，响应头 `X-Hub-Notice` 提示。
- **注册**：管理后台 `site.allowRegistration=false` 时关闭。

## 团队协作

- 契约文件（`docs/SPEC.md`、`packages/shared/**`、`packages/db/src/schema.ts/client.ts/crypto.ts`）由编排者维护，只读。
- 目录所有权、分支规则、依赖安装见 [AGENTS.md](AGENTS.md) 与 SPEC §12。
