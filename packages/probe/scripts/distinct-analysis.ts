/*
 * 可区分性分析：A 家族（实际后端分词器）冒充 B 家族（声称模型）时，
 * token 计数比值是否落在 B 的期望区间外。输出两种方法的冒充矩阵对比：
 * - 旧单次法（±10%，含协议开销）
 * - 差分法（±8%，纯文本，默认实现）
 * 用法：cd packages/probe && npx tsx scripts/distinct-analysis.ts
 */
import {
  O200K_BENCHMARK_TOKENS,
  PROTOCOL_OVERHEAD,
  TOKEN_COUNT_MARGIN,
  TOKEN_COUNT_TOLERANCE,
  VENDOR_CALIBRATION,
} from '../src/calibration.ts';

const vendors = Object.keys(VENDOR_CALIBRATION);
const tolSingle = TOKEN_COUNT_TOLERANCE + TOKEN_COUNT_MARGIN; // 0.10
const tolDiff = TOKEN_COUNT_TOLERANCE; // 0.08

console.log(`基准 o200k=${O200K_BENCHMARK_TOKENS} tokens`);
console.log(`单次法容差 ±${(tolSingle * 100).toFixed(0)}%（含协议开销 ${JSON.stringify(PROTOCOL_OVERHEAD)}）；差分法容差 ±${(tolDiff * 100).toFixed(0)}%（纯文本）`);

interface MatrixResult {
  detectable: number;
  undetectable: { claimed: string; actual: string; ratio: number }[];
}

function matrix(tol: number, label: string, useOverhead: boolean): MatrixResult {
  console.log(`\n===== ${label} =====`);
  console.log('各厂商期望值：');
  for (const v of vendors) {
    const cal = VENDOR_CALIBRATION[v];
    const overhead = useOverhead ? 8 : 0;
    const expected = Math.round(O200K_BENCHMARK_TOKENS * cal.ratio + overhead);
    console.log(`  ${v.padEnd(10)} ratio=${cal.ratio.toFixed(2)}  expected=${expected}  range=[${Math.floor(expected * (1 - tol))}, ${Math.ceil(expected * (1 + tol))}]`);
  }
  console.log('冒充矩阵：行=声称厂商(B)，列=实际后端(A)　✓=可检测　✗=不可区分　—=自身');
  let detectable = 0;
  const undetectable: { claimed: string; actual: string; ratio: number }[] = [];
  const rows: string[][] = [];
  for (const claimed of vendors) {
    const expectedB = O200K_BENCHMARK_TOKENS * (VENDOR_CALIBRATION[claimed]?.ratio ?? 1) + (useOverhead ? 8 : 0);
    const row: string[] = [];
    for (const actual of vendors) {
      if (claimed === actual) {
        row.push('—');
        continue;
      }
      const countA = O200K_BENCHMARK_TOKENS * (VENDOR_CALIBRATION[actual]?.ratio ?? 1) + (useOverhead ? 8 : 0);
      const ratio = countA / expectedB;
      const ok = ratio < 1 - tol || ratio > 1 + tol;
      if (ok) {
        detectable++;
      } else {
        undetectable.push({ claimed, actual, ratio });
      }
      row.push(ok ? `✓${ratio.toFixed(2)}` : `✗${ratio.toFixed(2)}`);
    }
    rows.push(row);
  }
  const header = ['声称\\实际', ...vendors.map((v) => v.slice(0, 8))];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cs: string[]) => cs.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  rows.forEach((r, i) => console.log(line([vendors[i] ?? '', ...r])));
  return { detectable, undetectable };
}

const single = matrix(tolSingle, `单次法（±${(tolSingle * 100).toFixed(0)}%，含协议开销）`, true);
const diff = matrix(tolDiff, `差分法（±${(tolDiff * 100).toFixed(0)}%，纯文本，默认实现）`, false);

const totalPairs = vendors.length * (vendors.length - 1);
console.log(`\n===== 总结 =====`);
console.log(`单次法：可检测 ${single.detectable}/${totalPairs}`);
console.log(`差分法：可检测 ${diff.detectable}/${totalPairs}（+${diff.detectable - single.detectable}）`);

// 差分法（更严）仍不可区分的组合 → 诚实列出
console.log('\n差分法仍不可区分的组合（token_count 对此无效，依赖 reasoning/knowledge/capability 等检查）：');
for (const u of diff.undetectable) {
  console.log(`  ${u.claimed} ← 实为 ${u.actual}（比值 ${u.ratio.toFixed(2)}）`);
}
console.log(`\n共 ${diff.undetectable.length} 个组合 token_count 无法区分（占比 ${Math.round((diff.undetectable.length / totalPairs) * 100)}%）`);
console.log('说明：openai/xai/bytedance（ratio 1.0）与 google/zhipu（1.05）两簇内部彼此不可区分，');
console.log('这是分词器本身对基准文本计数几乎相同的客观事实，任何容差都无法区分。');
