'use client';

import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Provider } from '@/lib/types';

export function ProviderSelector({
  providers,
  selected,
  onChange,
}: {
  providers: Provider[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((p) => p !== id) : [...selected, id]);
  };

  const sorted = useMemo(() => providers.slice().sort((a, b) => a.name.localeCompare(b.name)), [providers]);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No providers available. Configure a provider first.</p>;
  }

  return (
    <fieldset>
      <legend className="sr-only">Allowed providers</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {sorted.map((p) => {
          const active = selected.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              role="checkbox"
              aria-checked={active}
              onClick={() => toggle(p.id)}
              className={cn(
                'flex items-center justify-between rounded-md border px-3 py-2.5 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted',
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.supportedModels?.length || 0} models · {p.enabled ? 'enabled' : 'disabled'}
                </span>
              </span>
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                  active ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                )}
                aria-hidden
              >
                {active && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Leave all unchecked to allow every provider (unrestricted).
      </p>
    </fieldset>
  );
}
