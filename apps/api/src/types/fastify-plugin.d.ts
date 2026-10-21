/*
 * fastify-plugin@6（CJS + export =）在 Bundler moduleResolution 下无法解析类型，
 * 这里声明为「恒等包裹」函数（它运行时就是恒等包裹 + skip-override 标记）。
 */
declare module 'fastify-plugin' {
  import type { FastifyPluginCallback, FastifyPluginAsync } from 'fastify';
  export function fastifyPlugin<T extends FastifyPluginCallback | FastifyPluginAsync>(fn: T, options?: unknown): T;
  export default fastifyPlugin;
}
