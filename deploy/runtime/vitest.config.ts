import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 150_000,
    hookTimeout: 60_000,
    // supervisor 测试与真实子进程交互，串行执行
    fileParallelism: false,
  },
});
