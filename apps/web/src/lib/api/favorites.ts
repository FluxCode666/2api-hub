'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { ChannelListItem, Paginated } from '@hub/shared';
import { api, ApiRequestError } from './client';

let ids: readonly number[] | null = null;
let updatedAt = 0;
let version = 0;
let loading: Promise<readonly number[]> | null = null;
const listeners = new Set<() => void>();
const mutations = new Map<number, Promise<void>>();

function publish(next: readonly number[]) {
  ids = next;
  updatedAt = Date.now();
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function snapshot() { return ids; }
function serverSnapshot() { return null; }

// 多个榜单共享一次请求和结果，游客 401 表示空收藏。
async function loadFavorites(): Promise<readonly number[]> {
  if (loading) return loading;
  if (ids !== null && Date.now() - updatedAt < 60_000) return ids;
  const requestVersion = version;
  loading = api<Paginated<ChannelListItem>>('/me/favorites?pageSize=100')
    .then(async first => {
      const pages = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total / first.pageSize) - 1) }, (_, index) => api<Paginated<ChannelListItem>>(`/me/favorites?page=${index + 2}&pageSize=100`)));
      return [...first.items, ...pages.flatMap(page => page.items)].map(item => item.id);
    })
    .catch((error: unknown) => {
      if (error instanceof ApiRequestError && error.status === 401) return [];
      throw error;
    })
    .then(next => {
      // 较早发起的读取不能覆盖刚完成的收藏切换。
      if (requestVersion === version) publish(next);
      return ids ?? next;
    })
    .finally(() => { loading = null; });
  return loading;
}

export function useChannelFavorites(initialIds: readonly number[]): readonly number[] {
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => { void loadFavorites().catch(() => undefined); }, []);
  return current ?? initialIds;
}

export async function setChannelFavorite(id: number, active: boolean): Promise<void> {
  const pending = mutations.get(id);
  if (pending) return pending;
  const mutation = (async () => {
    if (ids === null) await loadFavorites();
    try {
      await api(`/me/favorites/${id}`, { method: active ? 'POST' : 'DELETE' });
      version += 1;
      publish(active ? [...new Set([...(ids ?? []), id])] : (ids ?? []).filter(value => value !== id));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        version += 1;
        publish([]);
      }
      throw error;
    }
  })().finally(() => { mutations.delete(id); });
  mutations.set(id, mutation);
  return mutation;
}
