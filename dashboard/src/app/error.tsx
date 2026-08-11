'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Log to the console for developer visibility only. No secrets are ever
    // included in error objects surfaced to the client.
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/30 p-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger/10">
        <AlertTriangle className="h-7 w-7 text-danger" aria-hidden />
      </div>
      <h1 className="mt-6 text-2xl font-semibold text-foreground">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        An unexpected error occurred while rendering this page.
      </p>
      <button
        onClick={reset}
        className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  );
}
