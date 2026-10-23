/*
 * 系统版本与站内热更新接口（RELEASE.md §4，admin 专属）。
 * /healthz 与 /api/v1/healthz 公开（带版本号）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HealthResponse, SystemVersionInfo, UpdateTask } from '@hub/shared';
import { badRequest, HttpError } from '../lib/errors';
import {
  canUpdate, completeTaskOnBoot, currentBuild, fetchLatestRelease,
  startRollback, startUpdate, systemVersionInfo,
} from '../lib/updater';
import { audit } from '../lib/audit';

export async function systemRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- 公开健康检查（带版本） ----------
  const healthHandler = async (): Promise<HealthResponse> => {
    const build = await currentBuild();
    return { ok: true, version: build.version };
  };
  app.get('/healthz', healthHandler);
  app.get('/api/v1/healthz', healthHandler);

  // ---------- 版本信息（admin） ----------
  app.get('/api/v1/admin/system/version', async (req): Promise<SystemVersionInfo> => {
    await app.requireRole(req, 'admin');
    const q = z.object({
      refresh: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional(),
    }).parse(req.query);
    return systemVersionInfo(q.refresh ?? false);
  });

  // ---------- 发起更新（admin，单飞） ----------
  app.post('/api/v1/admin/system/update', async (req, reply): Promise<UpdateTask> => {
    const admin = await app.requireRole(req, 'admin');
    const { targetVersion } = z.object({ targetVersion: z.string().min(1).max(50) }).parse(req.body);

    const update = await canUpdate();
    if (!update.ok) throw new HttpError(400, 'not_supported', update.reason ?? '当前环境不支持在线更新');

    // 检查目标版本是最新且大于当前
    const { release } = await fetchLatestRelease(true);
    if (!release) throw badRequest('无法获取最新版本信息');
    if (release.version !== targetVersion) throw badRequest(`目标版本 ${targetVersion} 不是最新版本 ${release.version}`);

    try {
      const task = await startUpdate(targetVersion, { id: admin.id, email: admin.email }, {
        audit: (action, meta) => audit(db, admin, action, 'system', 'update', meta, req.ip),
      });
      void reply.status(202);
      return task;
    } catch (err) {
      if (err instanceof Error && err.message.includes('进行中')) {
        throw new HttpError(409, 'update_in_progress', err.message);
      }
      throw err;
    }
  });

  // ---------- 回退（admin） ----------
  app.post('/api/v1/admin/system/rollback', async (req, reply): Promise<UpdateTask> => {
    const admin = await app.requireRole(req, 'admin');
    const update = await canUpdate();
    if (!update.ok) throw new HttpError(400, 'not_supported', update.reason ?? '当前环境不支持在线更新');

    try {
      const task = await startRollback({ id: admin.id, email: admin.email }, {
        audit: (action, meta) => audit(db, admin, action, 'system', 'rollback', meta, req.ip),
      });
      void reply.status(202);
      return task;
    } catch (err) {
      if (err instanceof Error && err.message.includes('进行中')) {
        throw new HttpError(409, 'update_in_progress', err.message);
      }
      if (err instanceof Error && err.message.includes('没有可回退')) {
        throw badRequest(err.message);
      }
      throw err;
    }
  });
}

/** 新版本启动时调用（在 app.listen 之前）：完成更新任务 */
export async function completeUpdateTaskOnBoot(): Promise<void> {
  const build = await currentBuild();
  await completeTaskOnBoot(build.version);
}
