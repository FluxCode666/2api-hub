/*
 * Fastify 应用工厂：buildApp() 供 dev 启动与测试复用。
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createDb } from '@hub/db';
import { registerErrorHandler } from './lib/errors';
import authPlugin from './plugins/auth';
import { publicRoutes } from './routes/public';
import { channelRoutes } from './routes/channels';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { merchantRoutes } from './routes/merchant';
import { adminRoutes } from './routes/admin';

export interface AppOptions {
  databaseUrl?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
  });

  const { db, sql } = createDb(opts.databaseUrl ?? process.env.DATABASE_URL);
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await sql.end();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });
  await app.register(authPlugin);

  await app.register(publicRoutes);
  await app.register(channelRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(merchantRoutes);
  await app.register(adminRoutes);

  app.get('/healthz', async (): Promise<{ ok: true }> => ({ ok: true }));

  return app;
}
