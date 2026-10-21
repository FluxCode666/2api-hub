/*
 * 模型名匹配：把上游模型名映射到目录模型。
 * 规则（SPEC §5.0 matchCatalogModel）：
 * - 忽略大小写
 * - 忽略日期后缀（如 -20250813、-0813）
 * - 忽略厂商前缀（anthropic/、openai/、google/ 等）
 * - 按 slug 精确匹配，再按 aliases 匹配
 */

/** 归一化：小写 → 去厂商前缀 → 去日期后缀 → 去空格 */
export function normalizeModelName(name: string): string {
  let s = name.trim().toLowerCase();
  // 厂商前缀（anthropic/claude-xxx → claude-xxx）
  const vendors = ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'zhipu', 'moonshot', 'bytedance', 'mistral', 'meta', 'qwen', 'doubao'];
  for (const v of vendors) {
    if (s.startsWith(`${v}/`)) {
      s = s.slice(v.length + 1);
      break;
    }
  }
  // 日期后缀：-20250813 / -0813 / -v1.0（保守：只去 8 位或 4 位纯数字尾缀，前面必须有 -）
  s = s.replace(/-(\d{8}|\d{4})$/, '');
  // 统一分隔：点号版本（claude-opus-5.5 → claude-opus-5-5）不在此做，slug 库已含两种别名
  return s;
}

/** 目录条目归一化集合（slug + aliases） */
export interface CatalogEntry {
  id: number;
  slug: string;
  aliases: string[];
}

export function matchCatalogModelImpl(upstreamName: string, catalog: CatalogEntry[]): number | null {
  if (!upstreamName || catalog.length === 0) return null;
  const target = normalizeModelName(upstreamName);
  if (!target) return null;
  // 第一轮：slug / alias 归一化后精确相等
  for (const entry of catalog) {
    const names = [entry.slug, ...entry.aliases];
    for (const n of names) {
      if (normalizeModelName(n) === target) return entry.id;
    }
  }
  // 第二轮：宽松匹配——去点号后再比（claude-opus-5.5 vs claude-opus-5-5）
  const targetDots = target.replace(/\./g, '-').replace(/-+/g, '-');
  for (const entry of catalog) {
    const names = [entry.slug, ...entry.aliases];
    for (const n of names) {
      const norm = normalizeModelName(n).replace(/\./g, '-').replace(/-+/g, '-');
      if (norm === targetDots) return entry.id;
    }
  }
  return null;
}

/**
 * 检查响应回显的模型名与请求模型是否一致（model_echo 检查用）。
 * 一致 = 完全相同，或归一化后相同，或回显是请求的「带日期/点号变体」。
 */
export function modelEchoMatches(requested: string, echoed: string | null | undefined): boolean {
  if (!echoed) return false;
  if (requested === echoed) return true;
  const a = normalizeModelName(requested);
  const b = normalizeModelName(echoed);
  if (!a || !b) return false;
  if (a === b) return true;
  const dots = (s: string) => s.replace(/\./g, '-').replace(/-+/g, '-');
  return dots(a) === dots(b);
}
