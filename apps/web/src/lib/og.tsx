import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import {themes} from './theme';
import type { MetaResponse, ModelDetail, SiteDetail } from '@hub/shared';

export const ogSize = { width: 1200, height: 630 };

const colors = {background:themes.light.background,panel:themes.light.card,line:themes.light.border,text:themes.light.foreground,muted:themes.light['muted-foreground'],accent:themes.light.primary,ink:themes.light['primary-foreground']};

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 600; style: 'normal' };
type Metric = { value: string; label: string };
type Card = { eyebrow: string; title: string; description: string; metrics: Metric[]; brand?: boolean };
let fontPromise: Promise<OgFont[]> | undefined;

async function fontData(filename: string): Promise<ArrayBuffer> {
  const data = await readFile(join(process.cwd(), 'public', 'fonts', 'og', filename));
  return Uint8Array.from(data).buffer;
}

function fonts(): Promise<OgFont[]> {
  fontPromise ??= Promise.all([
    fontData('Geist-Regular.ttf'),
    fontData('Geist-SemiBold.ttf'),
    fontData('NotoSansSC-Regular.woff'),
  ]).then(([regular, semibold, chinese]) => [
    { name: 'Geist', data: regular, weight: 400, style: 'normal' },
    { name: 'Geist', data: semibold, weight: 600, style: 'normal' },
    { name: 'Noto Sans SC', data: chinese, weight: 400, style: 'normal' },
    { name: 'Noto Sans SC', data: chinese, weight: 600, style: 'normal' },
  ]);
  return fontPromise;
}

const number = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
const percent = (value: number | null) => value === null ? '暂无数据' : `${(value * 100).toFixed(1)}%`;
const shorten = (text: string, limit: number) => Array.from(text).length > limit ? `${Array.from(text).slice(0, limit - 1).join('')}…` : text;

function BrandMark() {
  return <svg width="35" height="35" viewBox="0 0 36 36" fill="none">
    <path d="M5 27V16L18 8V20L31 12V27" stroke={colors.accent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="5" cy="28" r="3" fill={colors.accent} />
    <circle cx="31" cy="28" r="3" fill={colors.accent} />
  </svg>;
}

function ConnectionArt() {
  return <svg width="360" height="360" viewBox="0 0 360 360" fill="none" style={{ position: 'absolute', right: 32, top: 93, opacity: 0.85 }}>
    <circle cx="180" cy="180" r="147" stroke={colors.line} />
    <circle cx="180" cy="180" r="111" stroke={colors.line} />
    <ellipse cx="180" cy="180" rx="147" ry="52" stroke={colors.muted} transform="rotate(-34 180 180)" />
    <path d="M65 272L180 180L288 102" stroke={colors.accent} strokeWidth="1.5" />
    <rect x="146" y="146" width="68" height="68" rx="19" fill={colors.accent} />
    <path d="M165 189V174L179 165V181L195 171V189" stroke={colors.ink} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="65" cy="272" r="7" fill={colors.accent} />
    <circle cx="288" cy="102" r="6" fill={colors.accent} />
    <circle cx="271" cy="294" r="4" fill={colors.muted} />
    <circle cx="86" cy="69" r="4" fill={colors.muted} />
  </svg>;
}

async function image(card: Card): Promise<ImageResponse> {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', padding: 24, background: colors.background, color: colors.text, fontFamily: 'Geist, Noto Sans SC' }}>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '32px 40px', border: `1px solid ${colors.line}`, borderRadius: 24, overflow: 'hidden', background: colors.panel }}>
        {card.brand && <ConnectionArt />}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}><BrandMark /><span style={{ fontSize: 27, fontWeight: 600, letterSpacing: -1 }}>2API Hub</span></div>
          <span style={{ fontSize: 19, color: colors.muted }}>模型 · 渠道 · 真实数据</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40, maxWidth: card.brand ? 710 : 1050 }}>
          <div style={{ display: 'flex', color: colors.accent, fontSize: 19, marginBottom: 13 }}>{shorten(card.eyebrow, 64)}</div>
          <div style={{ display: 'flex', flexDirection: 'column', fontWeight: 600, fontSize: card.brand ? 66 : Array.from(card.title).length > 23 ? 49 : 64, lineHeight: 1.2, letterSpacing: -2 }}>
            {card.title.split('\n').map((line, index) => <span key={line} style={{ color: index ? colors.accent : colors.text }}>{shorten(line, 35)}</span>)}
          </div>
          <div style={{ display: 'flex', color: colors.muted, fontSize: 22, marginTop: 18, lineHeight: 1.5 }}>{shorten(card.description, card.brand ? 29 : 45)}</div>
        </div>
        <div style={{ display: 'flex', width: '100%', marginTop: 'auto', paddingTop: 24, borderTop: `1px solid ${colors.line}` }}>
          {card.metrics.map((metric, index) => <div key={metric.label} style={{ display: 'flex', flexDirection: 'column', width: '33.333%', paddingLeft: index ? 30 : 0, ...(index ? { borderLeft: `1px solid ${colors.line}` } : {}) }}>
            <span style={{ fontSize: metric.value.length > 12 ? 30 : 38, fontWeight: 600, lineHeight: 1.2, letterSpacing: -1 }}>{metric.value}</span>
            <span style={{ fontSize: 17, color: colors.muted, marginTop: 8 }}>{metric.label}</span>
          </div>)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 23, fontSize: 14, color: colors.muted }}><span>AI 中转站聚合导航</span><span>价格与探测数据以页面实时展示为准</span></div>
      </div>
    </div>,
    { ...ogSize, fonts: await fonts() },
  );
}

export function brandImage(meta?: MetaResponse): Promise<ImageResponse> {
  return image({
    brand: true,
    eyebrow: '让每一次 API 连接，都有据可依',
    title: '为每一次连接，\n找到更优解。',
    description: '比较真实价格、稳定性与模型可信度。',
    metrics: meta ? [
      { value: number(meta.counts.sites), label: '已收录站点' },
      { value: number(meta.counts.channels), label: '持续监测渠道' },
      { value: number(meta.counts.models), label: '覆盖模型' },
    ] : [
      { value: '透明比价', label: '看清实际价格' },
      { value: '持续探测', label: '了解真实稳定性' },
      { value: '交叉验证', label: '比较模型可信度' },
    ],
  });
}

export function modelImage(model: ModelDetail): Promise<ImageResponse> {
  const inputPrice = model.minInputPriceCny;
  return image({
    eyebrow: `${model.vendor.name} / 模型渠道指南`,
    title: model.displayName,
    description: '真实价格、稳定性与模型可信度，一起比较。',
    metrics: [
      { value: inputPrice === null ? '暂无报价' : `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(inputPrice)}`, label: '最低输入价 / 百万 Token' },
      { value: number(model.channelCount), label: '提供该模型的渠道' },
      { value: percent(model.bestUptime24h), label: '最佳 24h 可用率' },
    ],
  });
}

export function siteImage(site: SiteDetail): Promise<ImageResponse> {
  return image({
    eyebrow: `${site.isVerified ? '平台认证站点' : '站点档案'} / 渠道与口碑`,
    title: site.name,
    description: '看清渠道表现，再做下一次选择。',
    metrics: [
      { value: number(site.channels.length), label: '已上线渠道' },
      { value: percent(site.stats.avgUptime24h), label: '平均 24h 可用率' },
      { value: site.ratingSummary.avg === null ? '暂无评分' : `${site.ratingSummary.avg.toFixed(1)} / 5`, label: `${number(site.ratingSummary.count)} 条用户评价` },
    ],
  });
}
