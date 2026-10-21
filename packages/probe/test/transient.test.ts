import { describe, expect, it } from 'vitest';
import { isTransientErrorCode } from '../src/index.ts';

/**
 * 临时错误判定（SPEC 修订：临时错误不污染真伪分）：
 * - 429 / 5xx / timeout / network / dns / tls → 临时（真伪检测重试，仍失败记 null 不计分）
 * - 401 / 403 / 404 / 4xx（非 429）/ empty_response / invalid_response / ssrf_blocked → 非临时
 */
describe('isTransientErrorCode', () => {
  it.each([
    ['http_429', true],
    ['http_5xx', true],
    ['timeout', true],
    ['network', true],
    ['dns', true],
    ['tls', true],
    ['http_401', false],
    ['http_403', false],
    ['http_404', false],
    ['http_4xx', false],
    ['empty_response', false],
    ['invalid_response', false],
    ['ssrf_blocked', false],
  ])('%s → %s', (code, expected) => {
    expect(isTransientErrorCode(code)).toBe(expected);
  });

  it('null / undefined → false', () => {
    expect(isTransientErrorCode(null)).toBe(false);
    expect(isTransientErrorCode(undefined)).toBe(false);
  });
});
