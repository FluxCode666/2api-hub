/*
 * API 入口：pnpm dev（tsx watch --env-file=../../.env src/index.ts）
 */
import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 8711);
// 监听地址：本地开发默认 127.0.0.1；容器/生产由 API_HOST=0.0.0.0 指定
const host = process.env.API_HOST ?? '127.0.0.1';

const app = await buildApp({ logger: true });
try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
