/*
 * 认证插件：jose JWT（httpOnly cookie hub_session）+ bcryptjs 密码。
 */
import { fastifyPlugin as fp } from 'fastify-plugin';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '@hub/shared';
import type { Role, SessionUser } from '@hub/shared';
import { unauthorized, forbidden } from '../lib/errors';

const COOKIE_MAX_AGE = 7 * 24 * 3600; // 7 天

export interface AuthTokenPayload { sub: string; role: Role }

declare module 'fastify' {
  interface FastifyInstance {
    auth: {
      sign(user: { id: string; role: Role }): Promise<string>;
      setSessionCookie(reply: FastifyReply, token: string): void;
      clearSessionCookie(reply: FastifyReply): void;
      verify(token: string): Promise<AuthTokenPayload | null>;
    };
    requireAuth: (req: FastifyRequest) => Promise<SessionUser>;
    requireRole: (req: FastifyRequest, role: Role) => Promise<SessionUser>;
    optionalUser: (req: FastifyRequest) => Promise<SessionUser | null>;
    db: import('@hub/db').Database;
  }
  interface FastifyRequest {
    currentUser: SessionUser | null;
  }
}

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET 未配置');
  return new TextEncoder().encode(s);
}

export default fp(async (app: import('fastify').FastifyInstance) => {
  app.decorateRequest('currentUser', null);

  const auth = {
    async sign(user: { id: string; role: Role }): Promise<string> {
      return new SignJWT({ role: user.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(secret());
    },
    setSessionCookie(reply: FastifyReply, token: string) {
      void reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE,
      });
    },
    clearSessionCookie(reply: FastifyReply) {
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    },
    async verify(token: string): Promise<AuthTokenPayload | null> {
      try {
        const { payload } = await jwtVerify(token, secret());
        if (!payload.sub) return null;
        return { sub: payload.sub, role: (payload.role as Role) ?? 'user' };
      } catch {
        return null;
      }
    },
  };
  app.decorate('auth', auth);

  async function loadUser(req: FastifyRequest): Promise<SessionUser | null> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    const payload = await auth.verify(token);
    if (!payload) return null;
    const { users } = await import('@hub/db');
    const { eq } = await import('drizzle-orm');
    const rows = await app.db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
    const u = rows[0];
    if (!u || u.status !== 'active') return null;
    const su: SessionUser = {
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
    };
    return su;
  }

  app.decorate('optionalUser', async (req: FastifyRequest): Promise<SessionUser | null> => {
    if (req.currentUser) return req.currentUser;
    req.currentUser = await loadUser(req);
    return req.currentUser;
  });

  app.decorate('requireAuth', async (req: FastifyRequest): Promise<SessionUser> => {
    const u = await app.optionalUser(req);
    if (!u) throw unauthorized();
    return u;
  });

  app.decorate('requireRole', async (req: FastifyRequest, role: Role): Promise<SessionUser> => {
    const u = await app.requireAuth(req);
    if (u.role === 'admin') return u; // 管理员拥有全部权限
    if (role === 'merchant' && (u.role === 'merchant' || u.role === 'user')) return u; // 站长接口登录即可用（创建站点即发起入驻）
    if (u.role !== role) throw forbidden();
    return u;
  });
});
