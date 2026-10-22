import assert from 'node:assert/strict';
import { mockAdmin } from '../../src/lib/mock/admin';
import { mockUsers } from '../../src/lib/mock/fixtures';
import type { AdminChannel, Paginated } from '@hub/shared';
const user = mockUsers.find(user => user.role === 'admin')!;
for (const sort of ['recent', 'uptime', 'trust', 'failures']) {
  const result = await mockAdmin(`/admin/channels?sort=${sort}&pageSize=100`, 'GET', undefined, user) as Paginated<AdminChannel>;
  const metric = (item: AdminChannel) => sort === 'recent' ? Date.parse(item.updatedAt) : sort === 'uptime' ? item.stats?.uptime24h : sort === 'trust' ? item.stats?.trustScore : item.stats?.consecutiveFailures;
  assert(result.items.every((item, index) => {
    if (!index) return true;
    const before = metric(result.items[index - 1]!), value = metric(item);
    return value == null || before != null && (sort === 'recent' || sort === 'failures' ? before >= value : before <= value);
  }));
  console.log(`${sort}: PASS`);
}
