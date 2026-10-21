/*
 * 测试 setup：独立测试库 hub_test（与开发库隔离，审查 P1 #5）。
 * - vitest 不支持 --env-file，用 dotenv 加载根 .env 后把库名替换为 hub_test
 * - 强制校验：目标库名必须以 _test 结尾，否则直接退出（防止误写开发库）
 */
import { config } from 'dotenv';

config({ path: new URL('../../../.env', import.meta.url).pathname });

const url = process.env.DATABASE_URL?.replace(/\/hub$/, '/hub_test')
  ?? 'postgres://hub:hub@127.0.0.1:54329/hub_test';
if (!/_test$/.test(new URL(url).pathname.replace(/\//g, ''))) {
  console.error(`[test-setup] 拒绝连接非测试库：${url}`);
  process.exit(1);
}
process.env.DATABASE_URL = url;
