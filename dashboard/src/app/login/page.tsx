'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Boxes, KeyRound } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Label, FieldError } from '@/components/ui/input';
import { ApiRequestError } from '@/lib/api';

export default function LoginPage() {
  const { signIn, authenticated, ready } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (ready && authenticated) router.replace('/dashboard');
  }, [ready, authenticated, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(value);
      toast.success('Signed in', 'Welcome to the AI Gateway console.');
      router.replace('/dashboard');
    } catch (err) {
      const msg =
        err instanceof ApiRequestError && (err.status === 401 || err.status === 403)
          ? 'Invalid admin API key, or the key lacks admin role.'
          : err instanceof Error
            ? err.message
            : 'Unable to sign in.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8 shadow-card">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Boxes className="h-6 w-6" aria-hidden />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-foreground">AI Gateway Console</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with an admin API key to manage the gateway.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="admin-key">Admin API Key</Label>
            <div className="relative">
              <KeyRound
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="admin-key"
                type="password"
                autoComplete="off"
                className="pl-9"
                placeholder="sk-…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
                autoFocus
              />
            </div>
            <span id="login-error">
              <FieldError>{error}</FieldError>
            </span>
          </div>

          <Button type="submit" className="w-full" disabled={loading || !value.trim()}>
            {loading ? 'Verifying…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Your key is validated server-side and kept only for this browser session. It is never stored in
          localStorage.
        </p>
      </div>
    </div>
  );
}
