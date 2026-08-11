'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiRequest, clearAdminToken, getAdminToken, setAdminToken, ApiRequestError } from '@/lib/api';

interface AuthState {
  token: string | null;
  authenticated: boolean;
  ready: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(getAdminToken());
    setReady(true);
  }, []);

  const signIn = useCallback(async (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed) throw new ApiRequestError(400, 'An admin API key is required.');
    // Validate against a lightweight admin-only endpoint. A non-admin or
    // invalid key is rejected by the backend (401/403) — authorization stays
    // server-side; we never trust the client.
    setAdminToken(trimmed);
    try {
      await apiRequest('/admin/api/system');
      setToken(trimmed);
    } catch (err) {
      clearAdminToken();
      throw err;
    }
  }, []);

  const signOut = useCallback(() => {
    clearAdminToken();
    setToken(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ token, authenticated: !!token, ready, signIn, signOut }),
    [token, ready, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
