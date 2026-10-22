# Worker (@hub/worker) Handoff

**AGGREGATE READY: 2026-10-22 01:58 (+08)**

> 统计聚合已就绪并通过验收。后续两轮迭代（审查修复 + 按模型可信分）均已落地：
> **2026-10-22 02:50** 全模块 + 审查 P1 修复（原子领取 / 任务 lease / 测试隔离）完成；
> **2026-10-22 17:15** 按模型的可信分扩展完成（检测范围 modelScope + 模型级推荐分）。
> 当前：typecheck 通过、**5 文件 32 用例全过**（hub_test 隔离库）、开发环境 live 运行正常。

## 1. 架构

```
apps/worker/
├── src/
│   ├── index.ts               # 主入口：六个循环 + 健康服务 + settings 60s 刷新 + 优雅退出
│   ├── config.ts              # 配置（环境变量）+ settings 加载 + 运行期指标
│   ├── aggregate.ts           # 统计聚合（渠道/站点统计 + 模型级推荐分批量写入）
│   ├── aggregate-once.ts      # aggregate:once 脚本
│   ├── limiter.ts             # 并发限制器（全局 + 单站点，同步 acquire/release）
│   ├── scheduler.ts           # 定时可用性探测调度（原子领取 + 主/备模型探测）
│   ├── probes.ts              # 探测执行器（probe_runs 落库 + channel_models 回写 + 失败升级/恢复通知 + Key 脱敏兜底）
│   ├── tasks.ts               # 任务队列执行器（lease 全生命周期 + 三种任务）
│   ├── authenticity-schedule.ts # 定时真伪检测（modelScope 范围 + 合并任务 + 错峰）
│   ├── cleanup.ts             # 每日清理 30 天前 probe_runs
│   ├── notify.ts              # 通知写入
│   └── health.ts              # /healthz + /metrics
└── test/                      # vitest（hub_test 隔离库，串行）
    ├── setup.ts               # 强制测试库 _test 后缀 + dotenv
    ├── aggregate.test.ts      # 聚合/零样本/备用模型/模型级推荐分（8 个）
    ├── authenticity-schedule.test.ts # modelScope/立即到期/合并任务（5 个）
    ├── probes.test.ts         # 失败升级/恢复通知/Key 脱敏（5 个）
    ├── scheduler.test.ts      # 原子领取/主备探测/降频边界（6 个）
    └── tasks.test.ts          # lease/三种任务/重试耗尽（8 个）
```

### 六个循环（`src/index.ts`）

| 循环 | 周期 | 说明 |
|---|---|---|
| 聚合 | 启动立即 + 60s | channel_stats + site_stats + trust 自愈同步 + **channel_models.recommend_score** |
| 调度 | 5s | 原子领取到期渠道 → limiter 派发（主测 + 备用模型探测） |
| 任务 | 空闲 2s | claimNextTask（lease）→ 执行，与定时探测共享 limiter |
| settings 刷新 | 60s | 并发/超时/scope 等热生效 |
| 真伪定时 | 10min | sweep：主测 24h + 非主测按 modelScope/48h，每轮 ≤3 渠道 |
| 清理 | 启动 25h 后每 24h | 删 30 天前 probe_runs |

### 关键设计（含两轮审查修复）

- **聚合**（`aggregate.ts`）：SQL CTE 聚合（percentile_cont、DISTINCT ON、sparkline），只统计 `model = primary_model` 的 availability 记录（备用模型不计入渠道可用率）；JS 侧 `computeRecommendScore` 算分（`uptime^8` 非线性 + 假模型封顶 40 由 shared 保证）；`COALESCE` 防零样本 NOT NULL 违例；逐渠道 try/catch 不中断；只聚合 approved 站点（非 approved 的统计行清理）。
- **trust 自愈同步**（聚合内、模型级推荐分之前）：按 `(channel_id, model)` 取最新报告（`DISTINCT ON ... ORDER BY created_at DESC, id DESC`）批量同步 `channel_models.trust_score/trust_verdict/trust_checked_at`，只更新值不同的行（`IS DISTINCT FROM`）。不依赖每个写入方都写对（种子/历史 bug 的不一致在下一轮聚合自动修复）；主测模型同步后 `channel_stats.trust_score` 自然一致；推荐分保证用同步后的可信分。
- **模型级推荐分**：聚合末尾 SELECT 全部已映射 channel_models 行 → JS 按该模型自身 `trust_score` 计算 → **一条 `UPDATE ... FROM (VALUES)` 批量写入**（每批 500 行），不逐行往返。
- **调度原子领取**（`scheduler.ts`）：到期筛选 + 状态检查 + `FOR UPDATE SKIP LOCKED` + 推进 next_probe_at 在**一条 SQL** 中（多实例安全）；只领取全局剩余容量；最近恰好 3 条全败才降频 300s（±10% 抖动）；退出 `drain()` 等待在途探测。
- **主/备模型**：主测探测回写 channel_models（last_status/latency/tested_at/error）；备用模型（`channels.backup_model`）单独探测、独立记录，不碰渠道级状态。
- **任务 lease**（`tasks.ts`）：`locked_by/lease_token/heartbeat_at`（迁移 0002）；领取写新 lease；30s 心跳；**所有副作用带 `WHERE id AND lease_token` 校验**（旧执行者无法覆盖新执行者）；回收只看心跳过期；退出只归还本实例任务；attempts 上限进原子领取语句。
- **真伪检测范围**（`authenticity-schedule.ts`）：主测按 `authenticity.intervalHours`；非主测已映射模型按 `authenticity.modelScope`（primary=不做/featured=is_featured/all=全部，默认 all）+ `authenticity.secondaryIntervalHours`（默认 48h）；**从未检测的模型立即到期**；同渠道多到期模型合并进一个任务 `payload.models`；**已有 queued/running 任务时合并进现有任务 payload**（jsonb 去重并集——选择理由：不丢到期信号、不撞 probe_tasks_active_uq 唯一索引、任务执行侧无需改动）；`ON CONFLICT DO NOTHING` 兜底并发建任务；错峰 `(channel_id%12)×5min` 加在各自到期时间上。
- **authenticity 执行**：每个 model 用 `matchCatalogModel` 取自己的 CatalogHint（#10）；报告写 `channel_model_id` 关联 + task_id；trust 回写 channel_models。
- **Key 脱敏兜底**（`scrubKey`）：probe_runs.error_message / 任务 error / 通知正文落库前按解密后真实 Key 精确替换（任意长度）。
- **db.execute 参数约束**：不传 JS Date（ISO 字符串 + `::timestamptz` 或 `now()`）；数组用参数化 `ARRAY[...]::text[]`；bigserial 返回 string。

## 2. 运行方式

```bash
pnpm --filter @hub/worker dev      # 开发（tsx watch）
pnpm --filter @hub/worker start    # 生产
pnpm --filter @hub/worker typecheck
pnpm --filter @hub/worker test     # 33 个测试（hub_test 隔离库）
pnpm --filter @hub/worker aggregate:once
```

环境变量（有默认值）：`WORKER_HEALTH_PORT=8713`、`WORKER_HOST`（默认 127.0.0.0，容器访问设 0.0.0.0）、`WORKER_SCHEDULER_INTERVAL_SEC=5`、`WORKER_AGGREGATION_INTERVAL_SEC=60`、`WORKER_RETENTION_DAYS=30`、`WORKER_RECOVERY_TIMEOUT_MS=600000`（任务心跳过期阈值）、`WORKER_GRACEFUL_SHUTDOWN_MS=30000`、`WORKER_TASK_MAX_ATTEMPTS=3`、`WORKER_FLAKY_PROBE_INTERVAL_SEC=300`。

settings（60s 热刷新）：`probe.concurrency=8`、`probe.perSiteConcurrency=2`、`probe.timeoutMs=30000`、`authenticity.intervalHours=24`、**`authenticity.modelScope=all`**、**`authenticity.secondaryIntervalHours=48`**、`scoring.weights`。

**指标**：`curl http://127.0.0.1:8713/healthz` / `/metrics`（aggregatesRun、lastAggregateMs、probes、tasks、queueBacklog、probes24h）。

## 3. 验证记录

### 2026-10-22（trust 自愈同步）

- 测试（hub_test）：✅ 新增用例覆盖三重断言——人为制造不一致（行 95/genuine vs 最新报告 63/suspect）→ 聚合后行同步为 63/suspect；推荐分按同步后 63 计算；一致数据不重复写入（trust_checked_at 稳定）。**5 文件 33 用例全过**。
- 开发库验证（`aggregate:once`）：渠道 36 gpt-6-astra（cm_id=90）从 100/genuine 同步为 **63/suspect**；全库不一致行清零。

### 2026-10-22（按模型可信分扩展）

| 验证项 | 结果 |
|---|---|
| typecheck | ✅ |
| test（hub_test） | ✅ **32 用例全过**（新增 scope 三值/立即到期/合并任务/模型推荐分/封顶 40/channel_model_id 共 10 用例） |
| live 运行 | ✅ 重启后 sweep 立即入队 3 任务并完成（0 失败）；12 分钟内 6 份新报告、**6 个非主测模型**（claude-sonnet-5-5、deepseek-v4.1-flash、gpt-6.1-sol 等）；**94 个 channel_models.recommend_score 有值**；新报告 6/6 正确关联 channel_model_id；0 报错 |
| 模型分正确性 | ✅ 手算复核：trust=100 + uptime 0.993 + p50 364 → 97.5（库值一致）；不同渠道同名模型分数随各自延迟/uptime 差异化（97.5 vs 97.4） |

### 2026-10-22（审查修复轮）

typecheck + 26 用例全过；aggregate:once=34 渠道/14 站点/failed=0；重启观察 2 分钟零报错；手动任务 #89 lease 全流转验证。修复明细见 `docs/review/engine-review.md` 末尾「Worker 修复记录」。

### 2026-10-22（首轮）

AGGREGATE READY 验收：aggregate:once 36 渠道/12 站点；API `?sort=recommend` 非空 stats/recommendScore。

## 4. 已知问题与说明

1. **`.env` 读取被拦截**：CC Safety Net 拦截内联 `--env-file` 脚本（rule: secret.basename.env）。正式路径用 pnpm script 内 Node 官方 `--env-file`，不受影响。
2. **settings 热刷新范围**：并发/超时/modelScope/secondaryIntervalHours 60s 内生效；`scoring.weights` 聚合时实时读取。
3. **多实例**：渠道/任务领取均原子（SKIP LOCKED + lease），多实例安全；聚合幂等并发 upsert；metrics 为进程内存值。
4. **hub_test 残留**：API 测试的渠道/站点可能残留在 hub_test（approved 状态），worker 测试通过「断言自己渠道」方式隔离，不互相干扰；worker 测试自建目录（不依赖 API 种子）。
5. **sparkline 时区**：固定 UTC ISO 字符串（`...Z`）。
6. **sweep 节奏**：每轮最多 3 个渠道 × 10min 一轮，全量渠道的首次检测会分多轮完成（防启动打爆上游）——属预期行为。

## 5. 与其他包的边界

- 只调用 `@hub/probe` 公开导出，未改 probe 包。
- schema 变更仅经迁移 0002（lease 字段，已记录 CONTRACT-CHANGES）；`channel_models.recommend_score` 列由编排者的迁移 0003 提供，worker 只写入。
- API（8711）读取 channel_stats/site_stats/channel_models.recommend_score/notifications。
