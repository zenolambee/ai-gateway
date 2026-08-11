'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '@/lib/api';

export interface QueryState<T> {
  data: T | null;
  error: ApiRequestError | Error | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Minimal, dependency-free data-fetching hook with loading/error state and
 * manual refetch. Avoids pulling in a second state-management library while
 * still giving every page proper skeleton/error handling. Requests are
 * aborted on unmount / dependency change.
 */
export function useQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    fetcherRef
      .current(controller.signal)
      .then((res) => {
        if (active) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  return { data, error, loading, refetch };
}
