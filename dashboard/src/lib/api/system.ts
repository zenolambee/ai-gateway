import { apiRequest } from './client';
import type {
  BackupObject,
  BackupFileMeta,
  BackupValidateResult,
  RestoreReport,
  SystemInfo,
  HealthResponse,
  LogEntry,
} from '../types';

// ---- Backups ----
export async function createBackup(includeUsage = true): Promise<{ success: boolean; backup: BackupObject }> {
  return apiRequest('/admin/api/backup', { method: 'POST', body: { includeUsage } });
}

export async function listBackups(): Promise<BackupFileMeta[]> {
  const res = await apiRequest<{ backups: BackupFileMeta[] }>('/admin/api/backup');
  return res.backups || [];
}

export async function validateBackup(backup: BackupObject): Promise<BackupValidateResult> {
  return apiRequest('/admin/api/backup/validate', { method: 'POST', body: { backup } });
}

export async function restoreBackup(backup: BackupObject, dryRun = false): Promise<RestoreReport> {
  return apiRequest('/admin/api/backup/restore', { method: 'POST', body: { backup, dryRun } });
}

// ---- System / Health ----
export async function getSystemInfo(): Promise<SystemInfo> {
  return apiRequest<SystemInfo>('/admin/api/system');
}

export async function getProviderHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/admin/api/health');
}

// Liveness probe (public, unauthenticated).
export async function getLiveness(): Promise<{ status: string; uptime: number; version: string }> {
  return apiRequest('/health');
}

// ---- Logs ----
export async function getLogs(limit = 100): Promise<LogEntry[]> {
  const res = await apiRequest<{ entries: LogEntry[]; offset: number }>('/admin/api/logs', {
    query: { limit },
  });
  return res.entries || [];
}

// ---- Config (settings, read-only surface) ----
export interface ConfigResponse {
  providers: Array<{
    id: string;
    name: string;
    enabled: boolean;
    baseURL?: string;
    apiKeys?: string[];
    supportedModels?: string[];
    priority?: number;
    timeout?: number;
    adapter?: string;
  }>;
  reloadStats?: Record<string, unknown>;
}

export async function getConfig(): Promise<ConfigResponse> {
  return apiRequest<ConfigResponse>('/admin/api/config');
}
