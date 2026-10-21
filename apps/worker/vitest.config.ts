import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false, // 测试共享真实数据库，串行执行
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
