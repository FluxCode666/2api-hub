/*
 * 校准 CLI：对真实（官方或可信）上游多次请求，实测 input_tokens、
 * 协议开销拆分（空文本 vs 基准文本 vs 2× 基准文本差分）、建议区间，
 * 输出可直接粘贴进 calibration.ts 的代码片段。Key 不打印。
 *
 * 用法：
 *   pnpm --filter @hub/probe calibrate -- --base-url https://api.anthropic.com \
 *     --key sk-ant-xxx --protocol anthropic --model claude-sonnet-5-5 [--runs 5] [--vendor anthropic]
 */
import { BENCHMARK_TEXT, O200K_BENCHMARK_TOKENS, TOKEN_COUNT_TOLERANCE, VENDOR_CALIBRATION } from '../src/calibration.ts';
import { getAdapter, type ProtocolCapture } from '../src/adapters.ts';
import { redactWithKey } from '../src/types.ts';
import { safeFetch, readBodyLimited } from '../src/http.ts';
import { SseParser } from '../src/sse.ts';
import type { ChannelProtocol } from '@hub/shared';

interface CliArgs {
  baseUrl: string;
  apiKey: string;
  protocol: ChannelProtocol;
  model: string;
  runs: number;
  vendor: string | null;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--base-url' || a === '--key' || a === '--protocol' || a === '--model' || a === '--runs' || a === '--vendor') {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error(`缺少 ${a} 的值`);
        return null;
      }
      args[a] = v;
      i++;
    } else {
      console.error(`未知参数: ${a}`);
      return null;
    }
  }
  if (!args['--base-url'] || !args['--key'] || !args['--protocol'] || !args['--model']) {
    console.error('用法: pnpm --filter @hub/probe calibrate -- --base-url <url> --key <key> --protocol <p> --model <m> [--runs 5] [--vendor <slug>]');
    return null;
  }
  const protocols: ChannelProtocol[] = ['openai_chat', 'openai_responses', 'anthropic', 'gemini'];
  const protocol = args['--protocol'] as ChannelProtocol;
  if (!protocols.includes(protocol)) {
    console.error(`--protocol 必须是 ${protocols.join(' / ')} 之一`);
    return null;
  }
  const runs = args['--runs'] ? Number.parseInt(args['--runs'], 10) : 5;
  if (!Number.isFinite(runs) || runs < 1 || runs > 20) {
    console.error('--runs 需为 1–20');
    return null;
  }
  return {
    baseUrl: args['--base-url'],
    apiKey: args['--key'],
    protocol,
    model: args['--model'],
    runs,
    vendor: args['--vendor'] ?? null,
  };
}

interface OneRun {
  inputTokens: number | null;
  ok: boolean;
  error: string | null;
}

/** 发一次探测请求（max_tokens=1 只关心 input usage），返回 usage.input_tokens */
async function measure(args: CliArgs, userText: string): Promise<OneRun> {
  const adapter = getAdapter(args.protocol);
  const req = adapter.build(
    args.baseUrl,
    args.apiKey,
    {
      model: args.model,
      messages: [
        { role: 'system', content: 'You are a calibration tool.' },
        { role: 'user', content: userText },
      ],
      maxTokens: 8,
    },
    true,
  );
  try {
    const res = await safeFetch({
      url: req.url,
      method: 'POST',
      headers: req.headers,
      body: req.body,
      timeoutMs: 60_000,
      allowPrivate: process.env.ALLOW_PRIVATE_PROBE === 'true',
    });
    if (!res.ok) {
      const { text } = await readBodyLimited(res);
      return { inputTokens: null, ok: false, error: redactWithKey(text.slice(0, 150), args.apiKey) };
    }
    // 流式消费，取 usage
    const capture: ProtocolCapture = {
      text: '', thinkingText: null, thinkingSignature: null, modelEcho: null,
      inputTokens: null, outputTokens: null, shapeOk: null, shapeDetail: '',
      toolCalls: null, eventSequence: [], responseId: null, stopReason: null, raw: null,
    };
    const firstTokenAt = { atMs: null as number | null };
    const parser = new SseParser();
    const reader = res.body?.getReader();
    if (!reader) return { inputTokens: null, ok: false, error: '无响应体' };
    const decoder = new TextDecoder('utf-8', { fatal: false });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = parser.feed(decoder.decode(value, { stream: true }));
      for (const ev of events) adapter.feedEvent(capture, ev, firstTokenAt);
    }
    for (const ev of parser.flush()) adapter.feedEvent(capture, ev, firstTokenAt);
    if (capture.inputTokens === null) {
      return { inputTokens: null, ok: false, error: '流中未找到 usage.input_tokens' };
    }
    return { inputTokens: capture.inputTokens, ok: true, error: null };
  } catch (err) {
    return { inputTokens: null, ok: false, error: redactWithKey((err as Error).message, args.apiKey) };
  }
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // pnpm 传参会带 "--" 分隔符
  const cleanArgv = argv.filter((a) => a !== '--');
  const args = parseArgs(cleanArgv);
  if (!args) process.exit(1);

  console.log(`校准目标: ${args.baseUrl} (${args.protocol}, model=${args.model}, runs=${args.runs})`);
  console.log(`o200k 基准计数: ${O200K_BENCHMARK_TOKENS} tokens\n`);

  const EMPTY_PROMPT = 'hi';
  const DOUBLE = `${BENCHMARK_TEXT}\n\n${BENCHMARK_TEXT}`;

  const collect = async (label: string, text: string): Promise<number[]> => {
    const values: number[] = [];
    for (let i = 0; i < args.runs; i++) {
      const r = await measure(args, text);
      if (r.ok && r.inputTokens !== null) {
        values.push(r.inputTokens);
        console.log(`  ${label} run${i + 1}: input_tokens=${r.inputTokens}`);
      } else {
        console.log(`  ${label} run${i + 1}: 失败 — ${r.error ?? 'unknown'}`);
      }
    }
    return values;
  };

  console.log('[1/3] 空文本（测协议开销）：');
  const empties = await collect('empty', EMPTY_PROMPT);
  console.log('[2/3] 基准文本 ×1：');
  const singles = await collect('bench', BENCHMARK_TEXT);
  console.log('[3/3] 基准文本 ×2（差分法）：');
  const doubles = await collect('double', DOUBLE);

  console.log('\n===== 结果 =====');
  if (empties.length > 0 && singles.length > 0) {
    const emptyMed = Math.round(median(empties));
    const singleMed = Math.round(median(singles));
    console.log(`协议开销（empty 中位数）: ${emptyMed} tokens`);
    console.log(`单次 input（bench 中位数）: ${singleMed} tokens`);
    console.log(`纯文本 token（bench − empty）: ${singleMed - emptyMed}`);
  }
  if (singles.length > 0 && doubles.length > 0) {
    const singleMed = Math.round(median(singles));
    const doubleMed = Math.round(median(doubles));
    const diff = doubleMed - singleMed;
    const ratio = diff / O200K_BENCHMARK_TOKENS;
    console.log(`\n差分法: usage(2×) − usage(1×) = ${doubleMed} − ${singleMed} = ${diff} tokens`);
    console.log(`相对 o200k 系数: ×${ratio.toFixed(3)}（${O200K_BENCHMARK_TOKENS} → ${diff}）`);
    const suggested = { expected: diff, range: [Math.floor(diff * (1 - TOKEN_COUNT_TOLERANCE)), Math.ceil(diff * (1 + TOKEN_COUNT_TOLERANCE))] };
    console.log(`建议差分区间（±${(TOKEN_COUNT_TOLERANCE * 100).toFixed(0)}%）: [${suggested.range[0]}, ${suggested.range[1]}]（期望 ${suggested.expected}）`);
    if (args.vendor) {
      const existing = VENDOR_CALIBRATION[args.vendor];
      if (existing) {
        console.log(`\ncalibration.ts 现值: ${args.vendor} ratio=${existing.ratio}（来源: ${existing.source}）`);
        console.log(`实测偏差: ${((ratio / existing.ratio - 1) * 100).toFixed(1)}%`);
      }
      // 可粘贴片段
      const ratioRounded = Math.round(ratio * 1000) / 1000;
      const date = new Date().toISOString().slice(0, 10);
      console.log('\n----- 可直接粘贴进 calibration.ts 的片段 -----');
      console.log(`  ${args.vendor}: { ratio: ${ratioRounded}, source: 'calibrate CLI 实测 ${date}（${args.baseUrl} / ${args.model}，${args.runs} 次中位数）' },`);
      console.log('---------------------------------------------');
    } else {
      console.log('\n提示：加 --vendor <slug> 可输出可粘贴片段');
    }
  } else {
    console.log('\n样本不足（bench 或 double 失败），无法计算差分。检查 base-url/protocol/model 是否匹配。');
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('FATAL', redactWithKey(String(err), null));
  process.exit(1);
});
