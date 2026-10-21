/*
 * 并发限制器：全局 probe.concurrency + 单站点 probe.perSiteConcurrency。
 * 同步 acquire/release（避免领取与释放之间的竞态），只用于定时探测与 availability 任务。
 */
export interface ConcurrencyLimiter {
  /** 尝试占用；成功返回 release 句柄，失败返回 null */
  acquire(siteId: number): { siteId: number; release(): void } | null;
  /** 当前全局占用数 */
  readonly inFlight: number;
  /** 每站点当前占用（只读快照） */
  perSite(siteId: number): number;
}

export function createLimiter(globalMax: number, perSiteMax: number): ConcurrencyLimiter {
  const perSite = new Map<number, number>();
  let inFlight = 0;
  return {
    acquire(siteId) {
      if (inFlight >= globalMax) return null;
      const cur = perSite.get(siteId) ?? 0;
      if (cur >= perSiteMax) return null;
      inFlight += 1;
      perSite.set(siteId, cur + 1);
      let released = false;
      return {
        siteId,
        release() {
          if (released) return;
          released = true;
          inFlight -= 1;
          const n = perSite.get(siteId) ?? 1;
          if (n <= 1) perSite.delete(siteId);
          else perSite.set(siteId, n - 1);
        },
      };
    },
    get inFlight() {
      return inFlight;
    },
    perSite(siteId) {
      return perSite.get(siteId) ?? 0;
    },
  };
}
