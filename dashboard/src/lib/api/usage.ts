import { apiRequest } from './client';
import type {
  Overview,
  UsageSummary,
  ProviderUsage,
  ModelUsage,
  DailyUsage,
  MonthlyUsage,
  UsageDetailPage,
} from '../types';

export async function getOverview(): Promise<Overview> {
  return apiRequest<Overview>('/admin/api/overview');
}

export async function getUsageSummary(): Promise<UsageSummary> {
  const res = await apiRequest<{ summary: UsageSummary }>('/admin/api/usage/summary');
  return res.summary;
}

export async function getProviderUsage(): Promise<ProviderUsage[]> {
  const res = await apiRequest<{ providers: ProviderUsage[] }>('/admin/api/usage/providers');
  return res.providers || [];
}

export async function getModelUsage(providerId?: string): Promise<ModelUsage[]> {
  const res = await apiRequest<{ models: ModelUsage[] }>('/admin/api/usage/models', {
    query: providerId ? { providerId } : undefined,
  });
  return res.models || [];
}

export async function getDailyUsage(days?: number): Promise<DailyUsage[]> {
  const res = await apiRequest<{ daily: DailyUsage[] }>('/admin/api/usage/daily', {
    query: days ? { days } : undefined,
  });
  return res.daily || [];
}

export async function getMonthlyUsage(months?: number): Promise<MonthlyUsage[]> {
  const res = await apiRequest<{ monthly: MonthlyUsage[] }>('/admin/api/usage/monthly', {
    query: months ? { months } : undefined,
  });
  return res.monthly || [];
}

export interface UsageDetailFilters {
  apiKeyId?: string;
  providerId?: string;
  model?: string;
  status?: 'success' | 'error';
  stream?: boolean;
  page?: number;
  limit?: number;
}

export async function getUsageDetail(filters: UsageDetailFilters = {}): Promise<UsageDetailPage> {
  return apiRequest<UsageDetailPage>('/admin/api/usage/detail', { query: { ...filters } });
}
