/*
 * URL 校验：只允许 http/https，拒绝 javascript: 等危险协议与控制字符。
 */
import { z } from 'zod';

export function httpUrl(max = 500) {
  return z.string().max(max).refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: '只允许 http/https 链接' },
  );
}
