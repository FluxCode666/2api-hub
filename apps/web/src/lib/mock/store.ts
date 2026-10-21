import type { FeedbackItem, Notification, Review, ReviewStatus, SessionUser, UserStatus } from '@hub/shared';
import { mockNow, mockSites, mockUsers } from './fixtures';

export type StoredReview = Review & { userId: string; siteId: number; status?: ReviewStatus };
type MockState = {
  users: SessionUser[];
  userStatus: Record<string, UserStatus>;
  passwords: Record<string, string>;
  favorites: Record<string, number[]>;
  reviews: StoredReview[];
  notifications: Record<string, Notification[]>;
  feedback: FeedbackItem[];
};
const globalStore = globalThis as typeof globalThis & { __hubPublicMock?: MockState };
export const mockCommunityStore: MockState = globalStore.__hubPublicMock ??= {
  users: structuredClone(mockUsers), userStatus: {},
  passwords: { 'admin@2api.hub': 'admin123456', 'merchant@2api.hub': 'merchant123456', 'user@2api.hub': 'user123456' },
  favorites: {}, notifications: {}, feedback: [],
  reviews: mockSites.flatMap((site) => [
    { id: site.id * 10 + 1, siteId: site.id, userId: 'demo-review-1', rating: 5, content: '接入过程顺畅，价格与展示一致。这里是演示评价。', user: { nickname: '林间开发者', avatarUrl: null }, createdAt: mockNow, updatedAt: mockNow },
    { id: site.id * 10 + 2, siteId: site.id, userId: 'demo-review-2', rating: 4, content: '日常开发够用，建议先用自己的任务进行小额测试。演示评价。', user: { nickname: '独立造物者', avatarUrl: null }, createdAt: mockNow, updatedAt: mockNow },
    { id: site.id * 10 + 3, siteId: site.id, userId: 'demo-review-3', rating: 5, content: '多模型切换方便，能直接使用现有 SDK。演示评价。', user: { nickname: '一杯冷萃', avatarUrl: null }, createdAt: mockNow, updatedAt: mockNow },
  ]),
};
// 兼容开发环境 HMR 之前创建的状态。
mockCommunityStore.userStatus ??= {};
