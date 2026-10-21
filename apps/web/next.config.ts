import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const api = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8711';
const config: NextConfig = {
  transpilePackages: ['@hub/shared'],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  agentRules: false,
  async rewrites() {
    return process.env.HUB_MOCK === '1'
      ? [{ source: '/go/:id', destination: '/api/v1/go/:id' }]
      : [
          { source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` },
          { source: '/go/:id', destination: `${api}/api/v1/go/:id` },
        ];
  },
};
export default config;
