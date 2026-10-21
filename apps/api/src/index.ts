/*
 * API 入口：pnpm dev（tsx watch --env-file=../../.env src/index.ts）
 */
import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 8711);

const app = await buildApp({ logger: true });
try {
  await app.listen({ port, host: '127.0.0.1' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
