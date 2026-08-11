import { apiRequest } from './client';
import type {
  Provider,
  ProviderDetail,
  CreateProviderInput,
  UpdateProviderInput,
  ModelEntry,
  Connection,
} from '../types';

export async function listProviders(): Promise<Provider[]> {
  const res = await apiRequest<{ providers: Provider[] }>('/admin/api/providers');
  return res.providers || [];
}

export async function getProvider(id: string): Promise<Provider | undefined> {
  const providers = await listProviders();
  return providers.find((p) => p.id === id);
}

export async function getProviderDetail(id: string): Promise<ProviderDetail> {
  return apiRequest<ProviderDetail>(`/admin/api/providers/${encodeURIComponent(id)}`);
}

export async function createProvider(input: CreateProviderInput): Promise<Provider> {
  const body: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    baseURL: input.baseURL,
    supportedModels: input.supportedModels,
    enabled: input.enabled !== false,
  };
  if (input.adapter) body.adapter = input.adapter;
  if (typeof input.priority === 'number') body.priority = input.priority;
  if (typeof input.timeout === 'number') body.timeout = input.timeout;
  // Credential goes to the backend exactly once — it is written to the
  // server-side provider config and never returned or stored in the browser.
  if (input.apiKey) body.apiKeys = [input.apiKey];
  const res = await apiRequest<{ success: boolean; provider: Provider }>('/admin/api/providers', {
    method: 'POST',
    body,
  });
  return res.provider;
}

export async function updateProvider(id: string, input: UpdateProviderInput): Promise<Provider> {
  const res = await apiRequest<{ success: boolean; provider: Provider }>(
    `/admin/api/providers/${encodeURIComponent(id)}`,
    { method: 'PUT', body: input },
  );
  return res.provider;
}

export async function enableProvider(id: string): Promise<Provider> {
  const res = await apiRequest<{ success: boolean; provider: Provider }>(
    `/admin/api/providers/${encodeURIComponent(id)}/enable`,
    { method: 'POST' },
  );
  return res.provider;
}

export async function disableProvider(id: string): Promise<Provider> {
  const res = await apiRequest<{ success: boolean; provider: Provider }>(
    `/admin/api/providers/${encodeURIComponent(id)}/disable`,
    { method: 'POST' },
  );
  return res.provider;
}

export async function deleteProvider(id: string): Promise<void> {
  await apiRequest<{ success: boolean }>(`/admin/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function listAdapters(): Promise<string[]> {
  const res = await apiRequest<{ adapters: string[] }>('/admin/api/providers/adapters');
  return res.adapters || [];
}

export async function testProvider(
  id: string,
): Promise<{ providerId: string; success: boolean; latencyMs: number; error?: string }> {
  return apiRequest(`/admin/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
}

export async function listModels(): Promise<ModelEntry[]> {
  const res = await apiRequest<{ models: ModelEntry[] }>('/admin/api/models');
  return res.models || [];
}

export async function listConnections(providerId?: string): Promise<Connection[]> {
  const res = await apiRequest<{ accounts: Connection[]; authTypes?: string[] }>('/admin/api/accounts', {
    query: providerId ? { providerId } : undefined,
  });
  return res.accounts || [];
}

export async function addConnection(input: {
  id: string;
  providerId: string;
  name?: string;
  apiKey: string;
}): Promise<Connection> {
  const res = await apiRequest<{ success: boolean; account: Connection }>(
    `/admin/api/providers/${encodeURIComponent(input.providerId)}/connections`,
    {
      method: 'POST',
      body: { id: input.id, name: input.name, apiKey: input.apiKey },
    },
  );
  return res.account;
}

export async function listProviderConnections(providerId: string): Promise<Connection[]> {
  const res = await apiRequest<{ connections: Connection[] }>(
    `/admin/api/providers/${encodeURIComponent(providerId)}/connections`,
  );
  return res.connections || [];
}

export async function updateConnection(
  id: string,
  input: { displayName?: string; apiKey?: string },
): Promise<Connection> {
  const body: Record<string, unknown> = {};
  if (input.displayName !== undefined) body.displayName = input.displayName;
  // Only sent when the admin explicitly replaces the credential.
  if (input.apiKey) body.apiKey = input.apiKey;
  const res = await apiRequest<{ success: boolean; account: Connection }>(
    `/admin/api/accounts/${encodeURIComponent(id)}`,
    { method: 'PUT', body },
  );
  return res.account;
}

export async function enableConnection(providerId: string, connectionId: string): Promise<void> {
  await apiRequest(
    `/admin/api/providers/${encodeURIComponent(providerId)}/connections/${encodeURIComponent(connectionId)}/enable`,
    { method: 'POST' },
  );
}

export async function disableConnection(providerId: string, connectionId: string): Promise<void> {
  await apiRequest(
    `/admin/api/providers/${encodeURIComponent(providerId)}/connections/${encodeURIComponent(connectionId)}/disable`,
    { method: 'POST' },
  );
}

export async function testConnection(
  providerId: string,
  connectionId: string,
): Promise<{ success: boolean; latencyMs: number; error?: string | null }> {
  return apiRequest(
    `/admin/api/providers/${encodeURIComponent(providerId)}/connections/${encodeURIComponent(connectionId)}/test`,
    { method: 'POST' },
  );
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await apiRequest(`/admin/api/accounts/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
}
