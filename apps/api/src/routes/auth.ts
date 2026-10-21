/*
 * 认证接口（SPEC §7.2）：邮箱 + 密码，JWT 存 httpOnly cookie。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { users, settings } from '@hub/db';
import type { LoginInput, RegisterInput, SessionUser } from '@hub/shared';
import { unauthorized, HttpError } from '../lib/errors';

const registerSchema = z.object({
  email: z.string().email('邮箱格式不正确').max(200),
  password: z.string().min(8, '密码至少 8 位').max(100),
  nickname: z.string().min(1).max(50).optional(),
} satisfies Record<keyof RegisterInput, z.ZodTypeAny>);

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(100),
} satisfies Record<keyof LoginInput, z.ZodTypeAny>);

function toSessionUser(u: typeof users.$inferSelect): SessionUser {
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    role: u.role,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function authRoutes(app: FastifyInstance) {
  const db = app.db;

  app.post('/api/v1/auth/register', async (req, reply): Promise<SessionUser> => {
    // 读取 site.allowRegistration 设置
    const settingRows = await db.select().from(settings).where(eq(settings.key, 'site.allowRegistration')).limit(1);
    const allowReg = settingRows[0]?.value;
    if (allowReg === false) throw new HttpError(403, 'registration_closed', '当前未开放注册');

    const input = registerSchema.parse(req.body);
    const email = input.email.toLowerCase().trim();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) throw new HttpError(409, 'email_taken', '该邮箱已注册');
    const hash = await bcrypt.hash(input.password, 10);
    const nickname = input.nickname?.trim() || email.split('@')[0]!;
    const [u] = await db.insert(users).values({ email, passwordHash: hash, nickname }).returning();
    const token = await app.auth.sign({ id: u!.id, role: u!.role });
    app.auth.setSessionCookie(reply, token);
    void reply.status(201);
    return toSessionUser(u!);
  });

  app.post('/api/v1/auth/login', async (req, reply): Promise<SessionUser> => {
    const input = loginSchema.parse(req.body);
    const email = input.email.toLowerCase().trim();
    const u = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (!u || !(await bcrypt.compare(input.password, u.passwordHash))) {
      throw unauthorized('邮箱或密码错误');
    }
    if (u.status !== 'active') throw unauthorized('账号已被禁用');
    await db.execute(sql`UPDATE users SET last_login_at = now() WHERE id = ${u.id}`);
    const token = await app.auth.sign({ id: u.id, role: u.role });
    app.auth.setSessionCookie(reply, token);
    return toSessionUser(u);
  });

  app.post('/api/v1/auth/logout', async (_req, reply): Promise<{ ok: true }> => {
    app.auth.clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (req): Promise<SessionUser> => {
    const u = await app.requireAuth(req);
    return u;
  });
}
