/*
 * @hub/probe 对外 API（契约见 docs/SPEC.md §5.0）。
 * 当前为编排者放置的桩，由 GLM 替换为真实实现，导出签名保持不变。
 */
import type { AuthenticityReport, ChannelProtocol, ModelTier, ProbeResult } from '@hub/shared';

export interface ProbeTarget { baseUrl: string; apiKey: string; protocol: ChannelProtocol; model: string }
export interface ProbeOptions { timeoutMs?: number; allowPrivate?: boolean; signal?: AbortSignal }
export interface CatalogHint {
  slug: string;
  vendorSlug: string;
  tier: ModelTier;
  knowledgeCutoff: string | null;
  expectedTps: number | null;
}
export interface UpstreamModelList { ok: boolean; models: string[]; errorCode: string | null; errorMessage: string | null }
export type AuthenticityResult = Omit<AuthenticityReport, 'id' | 'channelId' | 'trigger' | 'createdAt'>;

export class ProbeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function probeAvailability(_target: ProbeTarget, _opts?: ProbeOptions): Promise<ProbeResult> {
  throw new Error('not implemented');
}

export async function listUpstreamModels(_target: Omit<ProbeTarget, 'model'>, _opts?: ProbeOptions): Promise<UpstreamModelList> {
  throw new Error('not implemented');
}

export async function probeAuthenticity(
  _target: ProbeTarget,
  _hint: CatalogHint | null,
  _opts?: ProbeOptions & { quick?: boolean },
): Promise<AuthenticityResult> {
  throw new Error('not implemented');
}

export function matchCatalogModel(_upstreamName: string, _catalog: { id: number; slug: string; aliases: string[] }[]): number | null {
  throw new Error('not implemented');
}

export async function assertSafeUrl(_url: string, _allowPrivate?: boolean): Promise<void> {
  throw new Error('not implemented');
}
