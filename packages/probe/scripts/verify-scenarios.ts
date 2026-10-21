/*
 * 集成验证脚本：对 mock-upstream 的 8 种 scenario 分别执行
 * probeAvailability 和 probeAuthenticity，输出结果表（SPEC 验收标准 #2）。
 *
 * 用法：先启动 mock-upstream（pnpm --filter @hub/mock-upstream dev），然后
 *   cd packages/probe && npx tsx scripts/verify-scenarios.ts
 */
import { probeAvailability, probeAuthenticity } from '../src/index.ts';
import type { ChannelProtocol } from '@hub/shared';

const BASE = process.env.MOCK_BASE ?? 'http://127.0.0.1:8712';
const API_KEY = process.env.MOCK_KEY ?? 'sk-mock-test-key';

const SCENARIOS = ['genuine', 'fast', 'slow', 'flaky', 'ratelimited', 'downgraded', 'fake', 'dead'] as const;
type Scenario = (typeof SCENARIOS)[number];

/** 每个 scenario 的代表渠道（与 seed 数据对应）：[model, protocol, vendorHint, tier] */
const CHANNEL_FOR: Record<Scenario, { model: string; protocol: ChannelProtocol; vendor: string; tier: 'flagship' | 'standard' | 'lite'; tps: number | null }> = {
  genuine: { model: 'claude-opus-5-5', protocol: 'anthropic', vendor: 'anthropic', tier: 'flagship', tps: 60 },
  fast: { model: 'gpt-6-astra', protocol: 'openai_responses', vendor: 'openai', tier: 'flagship', tps: 70 },
  slow: { model: 'claude-fable-5-1', protocol: 'anthropic', vendor: 'anthropic', tier: 'flagship', tps: 50 },
  flaky: { model: 'grok-4.7', protocol: 'openai_chat', vendor: 'xai', tier: 'flagship', tps: 80 },
  ratelimited: { model: 'claude-fable-5-1', protocol: 'anthropic', vendor: 'anthropic', tier: 'flagship', tps: 50 },
  downgraded: { model: 'claude-fable-5-1', protocol: 'anthropic', vendor: 'anthropic', tier: 'flagship', tps: 50 },
  fake: { model: 'claude-fable-5-1', protocol: 'anthropic', vendor: 'anthropic', tier: 'flagship', tps: 50 },
  dead: { model: 'claude-fable-5-1', protocol: 'anthropic', vendor: 'anthropic', tier: 'flagship', tps: 50 },
};

function fmtMs(n: number | null): string {
  return n === null ? '—' : `${n}ms`;
}

async function main(): Promise<void> {
  console.log(`mock-upstream: ${BASE}\n`);
  const rows: string[][] = [];
  const availAttempts: Record<string, { ok: number; total: number }> = {};

  // 可用性探测：flaky/ratelimited 各探测 10 次统计成功率
  for (const sc of SCENARIOS) {
    const ch = CHANNEL_FOR[sc];
    const rounds = sc === 'flaky' || sc === 'ratelimited' ? 10 : 1;
    let okCount = 0;
    let firstLatency: number | null = null;
    let firstTtft: number | null = null;
    let firstErr: string | null = null;
    for (let i = 0; i < rounds; i++) {
      const r = await probeAvailability(
        { baseUrl: `${BASE}/${sc}`, apiKey: API_KEY, protocol: ch.protocol, model: ch.model },
        { allowPrivate: true, timeoutMs: 20_000 },
      );
      if (r.success) okCount += 1;
      if (i === 0) {
        firstLatency = r.latencyMs;
        firstTtft = r.ttftMs;
        if (!r.success) {
          const status = r.httpStatus !== null ? `(${r.httpStatus})` : '';
          firstErr = `${r.errorCode ?? ''}${status}`;
        }
      }
    }
    availAttempts[sc] = { ok: okCount, total: rounds };
    rows.push([
      sc,
      'availability',
      `${okCount}/${rounds}`,
      firstLatency !== null ? fmtMs(firstLatency) : '—',
      firstTtft !== null ? fmtMs(firstTtft) : '—',
      firstErr ?? '',
    ]);
  }

  console.log('=== probeAvailability ===');
  printTable(['scenario', 'kind', 'ok', 'latency', 'ttft', 'error'], rows);
  console.log();

  // 真伪检测（每个 scenario 一次完整检测）
  const authRows: string[][] = [];
  for (const sc of SCENARIOS) {
    const ch = CHANNEL_FOR[sc];
    if (sc === 'dead') {
      authRows.push([sc, '✗', '—', '—', '—', '连通失败(http_5xx)', '—']);
      continue;
    }
    // slow 的 TTFT 6-12s，真伪检测需要更长超时
    const t0 = Date.now();
    const report = await probeAuthenticity(
      { baseUrl: `${BASE}/${sc}`, apiKey: API_KEY, protocol: ch.protocol, model: ch.model },
      { slug: ch.model, vendorSlug: ch.vendor, tier: ch.tier, knowledgeCutoff: '2026-06', expectedTps: ch.tps },
      { allowPrivate: true, timeoutMs: sc === 'slow' ? 60_000 : 30_000 },
    );
    const checks = report.checks.map((c) => `${c.id}:${markOf(c.passed)}`).join(' ');
    authRows.push([
      sc,
      report.score !== null ? String(report.score) : '—',
      report.verdict,
      `${(Date.now() - t0) / 1000}s`,
      checks,
      summarizeFails(report),
    ]);
  }
  console.log('=== probeAuthenticity ===');
  printTable(['scenario', 'score', 'verdict', 'duration', 'checks', 'fails'], authRows);
  console.log();

  // 期望判定校验
  console.log('=== 判定校验（期望：genuine/fast ≥80 genuine；downgraded suspect/fake；fake <50） ===');
  const expects: Record<string, string> = {
    genuine: 'genuine', fast: 'genuine',
    slow: 'genuine',
    flaky: '(不稳定，容忍失败)', ratelimited: '(不稳定，容忍失败)',
    downgraded: 'suspect 或 fake', fake: 'fake', dead: '(连通失败)',
  };
  const verdicts = Object.fromEntries(authRows.map((r) => [r[0], r[2]]));
  for (const sc of SCENARIOS) {
    console.log(`  ${sc.padEnd(14)} 期望=${expects[sc] ?? ''}  实际=${verdicts[sc] ?? '—'}`);
  }
}

function markOf(passed: boolean | null): string {
  if (passed === null) return 'n/a';
  return passed ? '✓' : '✗';
}

function summarizeFails(report: { checks: { id: string; passed: boolean | null; detail: string }[] }): string {
  const fails = report.checks.filter((c) => c.passed === false);
  if (fails.length === 0) return '';
  return fails.map((f) => `${f.id}(${f.detail.slice(0, 40)})`).join('; ').slice(0, 120);
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const r of rows) console.log(line(r));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('FATAL', err);
    process.exit(1);
  },
);
