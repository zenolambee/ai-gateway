import { apiRequest } from './client';
import type { ApiKey, CreateApiKeyInput, CreateApiKeyResult, QuotaAnalytics } from '../types';

interface KeysResponse {
  keys: ApiKey[];
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const res = await apiRequest<KeysResponse>('/admin/api/keys');
  return res.keys || [];
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  return apiRequest<CreateApiKeyResult>('/admin/api/keys', { method: 'POST', body: input });
}

export async function revokeApiKey(id: string): Promise<{ success: boolean; key: ApiKey }> {
  return apiRequest(`/admin/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}

export async function rotateApiKey(id: string): Promise<CreateApiKeyResult> {
  return apiRequest<CreateApiKeyResult>(`/admin/api/keys/${encodeURIComponent(id)}/rotate`, {
    method: 'POST',
  });
}

export async function deleteApiKey(id: string): Promise<{ success: boolean }> {
  return apiRequest(`/admin/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function updateApiKey(id: string, patch: Partial<ApiKey>): Promise<{ success: boolean; key: ApiKey }> {
  return apiRequest(`/admin/api/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

interface KeyUsageResponse {
  keyId: string;
  usage: { totalRequests?: number; totalTokens?: number; lastUsed?: number | null } | null;
  analytics: { usage?: unknown; quota?: QuotaAnalytics | null } | null;
}

export async function getApiKeyUsage(id: string): Promise<KeyUsageResponse> {
  return apiRequest<KeyUsageResponse>(`/admin/api/keys/${encodeURIComponent(id)}/usage`);
}

export async function getApiKeyQuota(id: string): Promise<{ keyId: string; quota: QuotaAnalytics | null }> {
  return apiRequest(`/admin/api/keys/${encodeURIComponent(id)}/quota`);
}
