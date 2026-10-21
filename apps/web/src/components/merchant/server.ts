import 'server-only';
import { notFound } from 'next/navigation';
import type { MerchantSiteDetail } from '@hub/shared';
import { serverApi, ApiRequestError } from '@/lib/api/server';

export async function getMerchantSite(id: string | number): Promise<MerchantSiteDetail> {
  try { return await serverApi<MerchantSiteDetail>(`/merchant/sites/${id}`); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }
}
