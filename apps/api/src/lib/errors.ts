/*
 * 统一错误处理与 HttpError 类。
 * 错误格式：{ error: { code, message, details? } }，message 为中文。
 */
import type { FastifyInstance, FastifyError } from 'fastify';
import type { ApiError } from '@hub/shared';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (msg = '资源不存在') => new HttpError(404, 'not_found', msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = '请先登录') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = '没有权限') => new HttpError(403, 'forbidden', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);

/** @hub/probe 未实现（GLM 开发中）时返回 503 */
export function probeUnavailable(): HttpError {
  return new HttpError(503, 'probe_unavailable', '检测引擎暂未就绪，请稍后重试');
}

export function isProbeNotImplemented(err: unknown): boolean {
  return err instanceof Error && err.message === 'not implemented';
}

function body(code: string, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof HttpError) {
      void reply.status(err.statusCode).send(body(err.code, err.message, err.details));
      return;
    }
    if (err instanceof ZodError) {
      void reply.status(400).send(body('validation_error', '参数校验失败', err.issues));
      return;
    }
    // fastify 自带错误（含 rate-limit 429、参数校验 400）
    const ferr = err as FastifyError;
    const status = ferr.statusCode ?? 500;
    if (status === 429) {
      void reply.status(429).send(body('rate_limited', '请求过于频繁，请稍后再试'));
      return;
    }
    if (status < 500) {
      void reply.status(status).send(body(ferr.code ?? 'bad_request', ferr.message));
      return;
    }
    req.log.error({ err: { message: ferr.message, stack: ferr.stack } }, '内部错误');
    void reply.status(500).send(body('internal_error', '服务器内部错误'));
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send(body('not_found', '接口不存在'));
  });
}
