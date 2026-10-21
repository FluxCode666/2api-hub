import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const api = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8711';
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  transpilePackages: ['@hub/shared'],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  agentRules: false,
  async rewrites() {
    return {
      // 内部转发让跳转也使用运行时 API 地址，避免镜像固化构建机的 localhost。
      afterFiles: [{ source: '/go/:id', destination: '/api/v1/go/:id' }],
      // 先经过同源 Route Handler，公开内容写入后才能同步失效页面缓存。
      fallback: process.env.HUB_MOCK === '1' ? [] : [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }],
    };
  },
};
export default config;
