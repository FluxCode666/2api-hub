/*
 * 测试 setup：加载根目录 .env（DATABASE_URL 等）。
 * vitest 不支持 --env-file，用 dotenv 补齐（注意此文件在 apps/worker/test/ 下，
 * 根目录 .env 需要向上三级）。
 */
import { config } from 'dotenv';

config({ path: new URL('../../../.env', import.meta.url).pathname });
