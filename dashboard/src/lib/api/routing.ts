import { apiRequest } from './client';
import type {
  RoutingConfig,
  RoutingStatus,
  RoutingActivityEntry,
  ModelRoutingRule,
} from '../types';

// ---- Routing Management ----

export async function getRoutingConfig(): Promise<RoutingConfig> {
  return apiRequest<RoutingConfig>('/admin/api/routing');
}

export async function updateRoutingConfig(patch: {
  strategy?: string;
  connectionStrategy?: string;
  keySelectionStrategy?: string;
  providerStrategies?: Record<string, string | null>;
}): Promise<{ success: boolean; persisted: boolean }> {
  return apiRequest('/admin/api/routing', { method: 'PUT', body: patch });
}

export async function getRoutingStatus(): Promise<RoutingStatus> {
  return apiRequest<RoutingStatus>('/admin/api/routing/status');
}

export async function getRoutingActivity(limit = 50): Promise<RoutingActivityEntry[]> {
  const res = await apiRequest<{ entries: RoutingActivityEntry[] }>('/admin/api/routing/activity', {
    query: { limit },
  });
  return res.entries || [];
}

export async function listRoutingRules(): Promise<ModelRoutingRule[]> {
  const res = await apiRequest<{ rules: ModelRoutingRule[] }>('/admin/api/routing/rules');
  return res.rules || [];
}

export async function createRoutingRule(rule: Omit<ModelRoutingRule, 'id'> & { id?: string }): Promise<ModelRoutingRule> {
  const res = await apiRequest<{ success: boolean; rule: ModelRoutingRule }>('/admin/api/routing/rules', {
    method: 'POST',
    body: rule,
  });
  return res.rule;
}

export async function updateRoutingRule(id: string, rule: Partial<Omit<ModelRoutingRule, 'id'>>): Promise<ModelRoutingRule> {
  const res = await apiRequest<{ success: boolean; rule: ModelRoutingRule }>(
    `/admin/api/routing/rules/${encodeURIComponent(id)}`,
    { method: 'PUT', body: rule },
  );
  return res.rule;
}

export async function deleteRoutingRule(id: string): Promise<void> {
  await apiRequest(`/admin/api/routing/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
