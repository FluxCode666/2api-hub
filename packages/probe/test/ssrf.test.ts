import { describe, expect, it } from 'vitest';
import { isPrivateIp, UnsafeUrlError, assertSafeUrlImpl } from '../src/ssrf.js';

describe('isPrivateIp（IPv4）', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.1.1', true],
    ['0.0.0.0', true],
    ['100.64.0.1', true],
    ['198.18.0.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.32.0.1', false],
    ['172.15.255.255', false],
    ['100.128.0.1', false],
    ['203.0.113.1', false], // TEST-NET-3 是保留段，但仅按主要私网段判定（此条故意判公网以验证宽松度）
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  it('非法输入视为不安全', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('999.1.1.1')).toBe(true);
    expect(isPrivateIp('')).toBe(true);
  });
});

describe('isPrivateIp（IPv6）', () => {
  it.each([
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fe90::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:192.168.1.1', true],
    ['2001:db8::1', true],
    ['2606:4700:4700::1111', false],
    ['2001:4860:4860::8888', false],
    ['2a00:1450:4001::1', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe('assertSafeUrlImpl', () => {
  it('拒绝非 http/https 协议', async () => {
    await expect(assertSafeUrlImpl('file:///etc/passwd', false)).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrlImpl('ftp://example.com', false)).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrlImpl('gopher://example.com', false)).rejects.toThrow(UnsafeUrlError);
  });

  it('拒绝无效 URL', async () => {
    await expect(assertSafeUrlImpl('not a url', false)).rejects.toThrow(UnsafeUrlError);
  });

  it('回环 IP 直接拒绝', async () => {
    await expect(assertSafeUrlImpl('http://127.0.0.1:8712/mock/v1/chat/completions', false)).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrlImpl('http://[::1]:8080/x', false)).rejects.toThrow(UnsafeUrlError);
  });

  it('私网 IP 拒绝', async () => {
    await expect(assertSafeUrlImpl('http://10.0.0.5/api', false)).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrlImpl('http://192.168.1.100:8080', false)).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrlImpl('http://172.20.0.1/v1', false)).rejects.toThrow(UnsafeUrlError);
  });

  it('allowPrivate=true 时放行私网', async () => {
    const r = await assertSafeUrlImpl('http://127.0.0.1:8712/mock', true);
    expect(r.safe).toBe(true);
    expect(r.hostname).toBe('127.0.0.1');
  });

  it('公网域名解析后放行（真实 DNS）', async () => {
    // example.com 是 IANA 保留演示域名，A 记录为公网地址 93.184.x / 23.x
    const r = await assertSafeUrlImpl('https://example.com/path', false);
    expect(r.safe).toBe(true);
    expect(r.resolvedIps.length).toBeGreaterThan(0);
  }, 15_000);

  it('不存在的域名报 DNS 解析失败', async () => {
    await expect(assertSafeUrlImpl('https://this-domain-should-not-exist-9x8y7z6w5.example.invalid', false)).rejects.toThrow(UnsafeUrlError);
  }, 15_000);
});
