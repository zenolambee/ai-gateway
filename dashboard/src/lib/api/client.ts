import type { ApiError } from '../types';

// -----------------------------------------------------------------------------
// Centralized API client for the AI Gateway backend.
//
// All requests go through the Next.js rewrite proxy at /api/gateway/* which
// forwards to the Express backend (see next.config.js). This keeps the admin
// Bearer token same-origin and means components never call fetch directly.
//
// The admin token is held in memory + sessionStorage (NOT localStorage) so it
// is cleared when the tab closes. We never store plaintext API *keys* created
// by the user — only the admin session token used to talk to the backend.
// -----------------------------------------------------------------------------

const BASE = '/api/gateway';
const TOKEN_STORAGE_KEY = 'aigw.admin.token';

let inMemoryToken: string | null = null;

export function setAdminToken(token: string | null) {
  inMemoryToken = token;
  if (typeof window === 'undefined') return;
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* sessionStorage unavailable — fall back to in-memory only */
  }
}

export function getAdminToken(): string | null {
  if (inMemoryToken) return inMemoryToken;
  if (typeof window === 'undefined') return null;
  try {
    inMemoryToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    inMemoryToken = null;
  }
  return inMemoryToken;
}

export function clearAdminToken() {
  setAdminToken(null);
}

export class ApiRequestError extends Error {
  status: number;
  code: string | null;
  requestId?: string;
  constructor(status: number, error: ApiError | string) {
    const msg = typeof error === 'string' ? error : error.message;
    super(msg);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = typeof error === 'string' ? null : error.code ?? null;
    this.requestId = typeof error === 'string' ? undefined : error.request_id;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getAdminToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  // Authorization is only ever sent to the backend proxy, never logged.
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}${buildQuery(opts.query)}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    cache: 'no-store',
  });

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const errObj =
      json && typeof json === 'object' && 'error' in json
        ? (json as { error: ApiError }).error
        : { message: res.statusText || `Request failed (${res.status})` };
    throw new ApiRequestError(res.status, errObj);
  }

  return json as T;
}
