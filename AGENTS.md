# 2API Hub — Agent 指南

开始工作前必须完整阅读 `docs/SPEC.md`（尤其是 §2 仓库结构、§12 团队协作规则），并阅读 `packages/shared/src/*.ts`、`packages/db/src/schema.ts`。

- 全站简体中文；代码注释简洁，用中文或英文均可，与所在文件保持一致。
- TypeScript strict，ESM，Node 22，pnpm workspace，包作用域 `@hub/*`。
- 端口：web 3210 / api 8711 / mock-upstream 8712 / worker 8713 / postgres 54329。
- 环境变量见 `.env.example`（根目录 `.env` 已存在，各 app 用 `dotenv` 或 `node --env-file=../../.env` 读取根目录 .env）。
