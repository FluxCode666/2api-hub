# v0.1.2 发版与运行时收尾交接（2026-10-24）

## 当前状态

本地审阅、修复、A/B 端到端演练、最终检查与 v0.1.2 三资产构建均已完成。根 `package.json.version=0.1.2`，`CHANGELOG.md` 已补中文更新说明及旧版本必须升级镜像的提示。

**尚未发布**：没有执行任何 git 写操作，也没有连接或修改线上服务器。所有改动均保留在工作区，由编排者审阅后统一提交和发版。未修改 `apps/web`、`packages/shared`、`packages/db/src/schema.ts` 或 `packages/probe` 源文件。

本地发布包记录的 commit 为 `e600f3826b433d1e6de9d70afbefb9252d40fce7`（当前 HEAD）；其中包含未提交修复，因此本地包仅用于验收，正式制品应由提交后的 tag CI 构建。

## 审阅发现与本次修正

| 发现 | 处理 |
| --- | --- |
| `path.includes('..')` 误删 Next.js `[...path]` 路由 | 保留 Kimi 的按路径段检查；进一步预检原始 tar 条目和链接目标，拒绝绝对路径、穿越及不支持的条目类型，整体失败，解压后再次核对真实链接边界 |
| 符号链接边界只做字符串前缀比较，会放过相邻目录前缀；macOS `/tmp` 又会被解析为 `/private/tmp` | 使用规范化后的真实根目录及带 `/` 的边界判断，覆盖内部合法相对链接和越界链接 |
| API 完整性校验不检查 `files.symlinks`，宽松解析会忽略坏行；supervisor 清单路径未检查越界，读目录可能抛异常退出 | 两侧均检查清单格式、文件类型、哈希、链接目标和真实路径边界，校验异常转为拒绝；v0.1.2 起缺少清单或空哈希清单失败，旧包保留兼容 |
| 发布清单排除 `files.symlinks` 自身，不能发现链接清单丢失/损坏 | 链接清单先生成，其文件哈希计入 `files.sha256` |
| 同 tag 历史残缺目录可能被复用；rename 任意失败会退回旧目录；`current` 先 unlink 导致非原子切换 | 非当前目标使用本次验证通过的 staging 替换；rename 错误不再吞掉；直接 rename 临时符号链接覆盖 current |
| API 已定义启动收敛函数，但入口未调用；查询缓存看不到 supervisor 改写的回退结果 | API 监听前调用收敛函数；任务写入使用临时文件 + rename；查询重读磁盘；重启中断的进行中任务变为 failed，终态保留 |
| supervisor 回退覆盖整份任务，只剩 `status/reason/from/to`，且使用契约外 `rolled_back_failed` | 保留任务 ID、类型、目标等字段，补 `message/finishedAt`；回退失败使用契约内 failed |
| 仅 API 健康不能识别前端代理损坏；启动窗口成功后未清除，旧版本后续抖动可能误触发回退 | API 直连及 web 代理都需 `ok=true` 且版本一致；首次同时就绪结束启动窗口；忽略切换期间过期的异步健康结果 |
| 镜像包复制的相对 symlink 可能被绝对化，且中断会残留半个目录 | `cpSync(..., verbatimSymlinks:true)`，复制到临时目录，校验后 rename |
| supervisor 预发布版本按字符串排序，`rc.10 < rc.2` | 改为逐标识符 semver 比较并加回归断言 |
| 新增解压测试依赖 `/tmp/hub-rel`，所谓穿越用例实际只解压正常包 | 改为自建 tar，覆盖通配路由、合法点号名、绝对路径、Windows 盘符、父目录、符号链接/硬链接越界、完整性及任务收敛，CI 独立运行 |
| 原 E2E 脚本未严格断言 succeeded，B 会在坏版切换前误认旧版健康为回退，回退目标也不符合 e2e.1 要求 | 独立 A/B 数据卷，严格校验 202、任务 ID、故障状态、回退时间和终态；使用根 Dockerfile 与随机回环端口；显式命名并清理卷；镜像源参数生效 |

`docs/RELEASE.md` 已同步清单要求、双路健康检查、启动收敛、任务结构和演练说明。原脚本第一次修订执行到 A 结束时发现 Bash 把紧邻变量的中文逗号当变量名，已改为 `${V2}`；后续完整重跑通过。runtime 测试首次失败是旧假发布包未提供新契约要求的清单，测试夹具已补齐后完整重跑通过。

## A/B 演练证据

命令：

```bash
NODE_IMAGE_REGISTRY=docker.m.daocloud.io/library scripts/release/e2e-update.sh
```

使用真实 esbuild/Next standalone 发布包、根 Dockerfile、独立 Postgres 和本地假 GitHub；fake latest 仅在本地返回演练 tag，不创建远端 Release。成功场景额外预置同 tag 残缺目录，验证可被正确替换。

关键输出（完整日志：`/tmp/hub-e2e-evidence/e2e-update.log`）：

```text
✓ 前端代理 healthz 新版本（v0.1.2-e2e.2）
✓ update-task.json succeeded（succeeded）
✓ 任务 ID 保留（upd-1792773566640）
✓ API 直连版本（v0.1.2-e2e.2）
✓ 更新后首页（200）
✓ 更新后 /api/v1/meta（200）
✓ current 已切换（releases/v0.1.2-e2e.2）
✓ 坏版本 API 正常且版本已切换（v0.1.2-e2e.2）
✓ 坏版本 web 代理 healthz（500）
✓ 坏版本 web 代理 meta（500）
✓ update-task.json rolled_back（rolled_back）
✓ 观察到坏版本后 66s 自动回退（60s 窗口 + 10s 巡检）
✓ 回退保留原任务 ID（upd-1792773574153）
✓ 回退后代理 healthz（v0.1.2-e2e.1）
✓ 回退后 API 直连版本（v0.1.2-e2e.1）
✓ 回退后首页（200）
✓ 回退后 /api/v1/meta（200）
✓ 管理员可见回退任务（rolled_back）
✓ supervisor 运行版本（v0.1.2-e2e.1）
[supervisor] 新版本 v0.1.2-e2e.2 在 60s 内未通过健康检查（HTTP 500） → 自动回退
[supervisor] 回退到 v0.1.2-e2e.1（原因：新版本健康检查未通过：HTTP 500）
演练完成：26 项断言通过
```

A/B 使用的容器、网络、显式命名的数据卷、镜像和临时发布包已清理。接手时遗留的 `hub-e2e-app/gh/pg`、其附属匿名卷、`hub-e2e-net` 和三份调试镜像也已清理；未执行任何全局 prune。API/Worker 最终测试使用另一个随机回环端口的 `hub-e2e-check-pg-*` 容器和专属卷，已清理。未操作 `hub-postgres`、本机 3210/8711/8712/8713 服务或任何 `2api-hub-*` 线上资源。

## 最终检查与发布资产

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| `pnpm -r typecheck` | 通过 | `/tmp/hub-e2e-evidence/typecheck.log` |
| `pnpm --filter @hub/api test` | 60/60 | `/tmp/hub-e2e-evidence/api.log` |
| `pnpm --filter @hub/worker test` | 33/33 | `/tmp/hub-e2e-evidence/worker.log` |
| `pnpm test:runtime` | 6/6 | `/tmp/hub-e2e-evidence/runtime.log` |
| `pnpm --filter @hub/web build`（CI 同款 `HUB_SKIP_API_PRERENDER=1`） | 通过 | `/tmp/hub-e2e-evidence/web-build.log` |
| `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -no-color` | 退出 0，无输出 | `/tmp/hub-e2e-evidence/actionlint.log` |
| `pnpm release:build` | v0.1.2 三资产 | `/tmp/hub-e2e-evidence/release-build.log` |
| 实际解压正式包，API + supervisor 完整性验证 | 通过；删除 `[...path]/route.js` 后两侧均拒绝 | `/tmp/hub-e2e-evidence/artifact.log` |
| 根 Dockerfile 构建 v0.1.2 | 通过；烟雾镜像已删除 | `/tmp/hub-e2e-evidence/docker-v012-build.log` |
| `git diff --check` | 通过 | 工作区 |

正式版本本地资产：

- `dist/2api-hub-v0.1.2.tar.gz`（约 24.8 MB）
- `dist/checksums.txt`
- `dist/release-manifest.json`

发布目录为 `dist/release/v0.1.2/`。包内 `files.sha256` 覆盖 1831 个普通文件，`files.symlinks` 记录 29 个符号链接，包含 Next.js `[...path]` 路由相关文件，清单、外层 checksum 与 release-manifest 均已实际核对。

tar.gz SHA-256：`1e0ce6e32b6264b9ab12a26de834b849354470f4b433316458f08968ec839c45`（以 `dist/checksums.txt` 为准）。

## 已知问题与边界

1. **旧版本必须升级镜像**：v0.1.0 / v0.1.1 的更新器和镜像层 supervisor 均有事故相关缺陷，不能依赖旧版站内更新来完成本次修复。新 supervisor 也不会通过发布 tar 包替换。
2. **既有的 15 分钟全流程超时尚未实现**：当前只有 GitHub 查询 15s、单次下载 120s 等局部超时，解压与任务整体没有契约 §4 所述 15 分钟截止。需要 API owner 后续单独实现取消、清理与超时状态，未在本次事故修复中扩大改造。
3. **既有单飞窗口与重启间隙**：后台发送 SIGHUP 后会释放内存锁，旧 API 完全退出前仍有极短窗口可接受另一请求；尚未把持久化 restarting 状态作为全程互斥锁。正常演练单次请求通过，建议后续以明确 supervisor 确认/任务租约完善。
4. **既有崩溃退避与契约不完全一致**：`startChild` 每次将退避重置为 1000，当前实际重启等待通常为 2s，未逐步增长到 30s；崩溃计数也是切换窗口内各进程累计，未按每个进程连续计数。本次 API 正常、web 500 的演练走 60s 健康超时路径，不依赖该分支。
5. **镜像升级与进程重建边界**：双路健康自动回退窗口目前在 SIGHUP 切换时启用；supervisor 首次启动选择镜像/持久化 current 时未启用该窗口。且 max(current, 镜像版本) 可能在容器重建后再次选中更高的坏镜像；镜像升级仍需人工核验，并在必要时改回镜像 tag。首次启动校验/迁移失败有原有回退处理。
6. **API succeeded 的语义**：按契约，新 API 启动即收敛为 succeeded；前端代理若失败，supervisor 随后改写为 rolled_back。E2E 验证了这个最终状态及管理员查询，但 succeeded 本身不等价于已通过完整健康窗口。
7. **范围外现存构建告警**：`packages/probe/src/adapters.ts` 有重复 `case 'response.failed'` 的 esbuild/Vite 告警；遵守所有权约束未修改。检查均退出 0；本次不裁定这两段业务处理的取舍。
8. 回退恢复代码与服务，不逆向撤销数据库迁移；本次没有新增迁移。将来破坏性 schema 变更需另行设计兼容与恢复方案。

## 上线步骤建议（仅建议，本次未执行）

1. 编排者审阅工作区 diff 和上述边界，提交修复，确认根版本、CHANGELOG 与 tag 均为 v0.1.2，再由现有 tag Release CI 产出正式包与多架构镜像。不要上传当前未提交工作区生成的验收包。
2. 保存当前部署 `.env`、数据库和应用数据卷备份，记录旧镜像 tag/digest；确认正式 CI 门禁、三资产及镜像已可用。
3. 在生产部署目录修改 `.env`：`HUB_IMAGE_TAG=v0.1.2`，执行 `docker compose pull && docker compose up -d`，保留现有数据库与应用数据卷。
4. 在容器内检查 API `/healthz` 返回 v0.1.2，从用户入口检查首页、`/api/v1/healthz`、`/api/v1/meta` 返回 200 且版本正确；核对 `supervisor.json.version/lastHealthyAt`、管理员版本对话框和日志。至少观察 70 秒；首次镜像升级不依赖 SIGHUP 自动回退窗口。
5. 镜像升级失败时恢复旧 `HUB_IMAGE_TAG` 再 pull/up。若应用数据卷 `current` 已选中过更高版本，单改镜像 tag 会被 max(current, 镜像版本) 保留；需由上线负责人按备份与实际状态处理 current，再核验服务，禁止删除生产数据卷。
6. 后续正常版本即可使用 v0.1.2 内置的站内更新器；正式版本上线后继续验证代理链路与任务终态。
