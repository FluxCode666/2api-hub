/*
 * 可区分性分析：A 家族（实际后端分词器）冒充 B 家族（声称模型）时，
 * token 计数比值是否落在 B 的期望区间外。输出冒充矩阵 + 建议。
 * 用法：cd packages/probe && npx tsx scripts/distinct-analysis.ts
 */
import {
  O200K_BENCHMARK_TOKENS,
  PROTOCOL_OVERHEAD,
  TOKEN_COUNT_MARGIN,
  TOKEN_COUNT_TOLERANCE,
  VENDOR_CALIBRATION,
} from '../src/calibration.ts';

const tol = TOKEN_COUNT_TOLERANCE + TOKEN_COUNT_MARGIN;
const vendors = Object.keys(VENDOR_CALIBRATION);

console.log(`基准 o200k=${O200K_BENCHMARK_TOKENS} tokens，区间容差=±${(tol * 100).toFixed(0)}%，协议开销=${JSON.stringify(PROTOCOL_OVERHEAD)}`);
console.log('\n各厂商期望值（以 anthropic 协议开销 8 为例）：');
for (const v of vendors) {
  const cal = VENDOR_CALIBRATION[v];
  const expected = Math.round(O200K_BENCHMARK_TOKENS * cal.ratio + 8);
  console.log(`  ${v.padEnd(10)} ratio=${cal.ratio.toFixed(2)}  expected=${expected}  range=[${Math.floor(expected * (1 - tol))}, ${Math.ceil(expected * (1 + tol))}]`);
}

console.log('\n冒充矩阵：行=声称厂商(B)，列=实际后端(A)　✓=可检测　✗=不可区分　—=自身');
const cells: string[][] = [];
for (const claimed of vendors) {
  const calB = VENDOR_CALIBRATION[claimed];
  const expectedB = O200K_BENCHMARK_TOKENS * calB.ratio + 8;
  const row: string[] = [];
  for (const actual of vendors) {
    if (claimed === actual) {
      row.push('—');
      continue;
    }
    const calA = VENDOR_CALIBRATION[actual];
    const countA = O200K_BENCHMARK_TOKENS * calA.ratio + 8;
    const ratio = countA / expectedB;
    const detectable = ratio < 1 - tol || ratio > 1 + tol;
    row.push(detectable ? `✓(${ratio.toFixed(2)})` : `✗(${ratio.toFixed(2)})`);
  }
  cells.push(row);
}
const header = ['声称\\实际', ...vendors.map((v) => v.slice(0, 8))];
const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
const line = (cs: string[]) => cs.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
cells.forEach((r, i) => console.log(line([vendors[i] ?? '', ...r])));

// 不可区分组合统计
console.log('\n不可区分组合（token_count 对此组合无效）：');
let undetectable = 0;
for (let i = 0; i < vendors.length; i++) {
  for (let j = 0; j < vendors.length; j++) {
    if (i === j) continue;
    const claimed = vendors[i]!;
    const actual = vendors[j]!;
    const expectedB = O200K_BENCHMARK_TOKENS * VENDOR_CALIBRATION[claimed].ratio + 8;
    const countA = O200K_BENCHMARK_TOKENS * VENDOR_CALIBRATION[actual].ratio + 8;
    const ratio = countA / expectedB;
    if (ratio >= 1 - tol && ratio <= 1 + tol) {
      console.log(`  ${claimed} ← 实为 ${actual}（比值 ${ratio.toFixed(2)}，落在 ±${(tol * 100).toFixed(0)}% 区间内）`);
      undetectable++;
    }
  }
}
const totalPairs = vendors.length * (vendors.length - 1);
console.log(`\n共 ${totalPairs} 个冒充组合，可检测 ${totalPairs - undetectable}，不可区分 ${undetectable}`);
