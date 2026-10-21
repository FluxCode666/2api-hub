import type { ApiError } from '@hub/shared';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function readResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  if (!response.ok) {
    const error = data as Partial<ApiError> | undefined;
    throw new ApiRequestError(response.status, error?.error?.code ?? 'request_failed', error?.error?.message ?? `请求失败（${response.status}）`, error?.error?.details);
  }
  return data as T;
}

export function apiPath(path: string): string {
  const normalized = path.startsWith('/api/v1') ? path.slice(7) : path;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}
