'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, Search, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { NAV_ITEMS } from './nav-config';
import { cn } from '@/lib/utils';

export function Header({
  title,
  onOpenMobileNav,
}: {
  title: string;
  onOpenMobileNav: () => void;
}) {
  const { signOut } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const env = process.env.NEXT_PUBLIC_ENV || 'development';

  // Client-side navigation search over loaded nav entities. Not a fake backend
  // search — it filters the known routes/pages the user can jump to.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return NAV_ITEMS.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 6);
  }, [query]);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-card/80 px-4 backdrop-blur">
      <button
        onClick={onOpenMobileNav}
        className="rounded-md p-2 text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>

      <h1 className="hidden truncate text-lg font-semibold text-foreground sm:block">{title}</h1>

      <div className="relative ml-auto w-full max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="Search pages…"
          aria-label="Search"
          className="h-9 w-full rounded-md border border-input bg-card pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {focused && matches.length > 0 && (
          <div className="absolute mt-1 w-full overflow-hidden rounded-md border border-border bg-card shadow-card">
            {matches.map((m) => (
              <button
                key={m.href}
                onMouseDown={() => {
                  router.push(m.href);
                  setQuery('');
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <m.icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <span
        className={cn(
          'hidden rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset sm:inline-flex',
          env === 'production'
            ? 'bg-success/10 text-success ring-success/20'
            : 'bg-primary/10 text-primary ring-primary/20',
        )}
      >
        {env}
      </span>

      <button
        onClick={signOut}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Sign out</span>
      </button>
    </header>
  );
}
