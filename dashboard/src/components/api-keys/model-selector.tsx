'use client';

import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Provider } from '@/lib/types';

export function ModelSelector({
  providers,
  selectedProviders,
  selectedModels,
  onChange,
}: {
  providers: Provider[];
  selectedProviders: string[];
  selectedModels: string[];
  onChange: (models: string[]) => void;
}) {
  // Model options are dependent on the selected providers. When no provider is
  // selected the whole selector is disabled — the backend Model Registry (via
  // provider.supportedModels) is the source of truth for what's available.
  const groups = useMemo(() => {
    return providers
      .filter((p) => selectedProviders.includes(p.id))
      .map((p) => ({
        provider: p,
        models: (p.supportedModels || []).slice().sort(),
      }));
  }, [providers, selectedProviders]);

  const toggle = (model: string) => {
    onChange(selectedModels.includes(model) ? selectedModels.filter((m) => m !== model) : [...selectedModels, model]);
  };

  if (selectedProviders.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        Select at least one provider to choose allowed models.
      </div>
    );
  }

  const allModels = Array.from(new Set(groups.flatMap((g) => g.models)));
  if (allModels.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        The selected providers expose no models. Leave empty to allow all.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map(({ provider, models }) =>
        models.length === 0 ? null : (
          <div key={provider.id}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{provider.name}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {models.map((model) => {
                const active = selectedModels.includes(model);
                return (
                  <button
                    key={`${provider.id}:${model}`}
                    type="button"
                    role="checkbox"
                    aria-checked={active}
                    onClick={() => toggle(model)}
                    className={cn(
                      'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                      active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted',
                    )}
                  >
                    <span className="truncate font-medium text-foreground">{model}</span>
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
          </div>
        ),
      )}
      <p className="text-xs text-muted-foreground">Leave all unchecked to allow every model from the chosen providers.</p>
    </div>
  );
}
