'use client';

import { useMemo, useState } from 'react';
import { Boxes } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useQuery } from '@/lib/use-query';
import { listModels, getModelUsage } from '@/lib/api';
import { formatCompact } from '@/lib/utils';

function capList(caps?: Record<string, boolean | undefined>): string[] {
  if (!caps) return [];
  return Object.entries(caps)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

export default function ModelsPage() {
  const modelsQuery = useQuery(() => listModels(), []);
  const usageQuery = useQuery(() => getModelUsage(), []);
  const [providerFilter, setProviderFilter] = useState('');
  const [capFilter, setCapFilter] = useState('');

  const models = useMemo(() => modelsQuery.data || [], [modelsQuery.data]);
  const usageByModel = new Map((usageQuery.data || []).map((u) => [u.model, u]));

  const providerOptions = useMemo(() => {
    const set = new Set<string>();
    models.forEach((m) => (m.providerIds || (m.provider ? [m.provider] : [])).forEach((p) => set.add(p)));
    return Array.from(set).sort();
  }, [models]);

  const capOptions = useMemo(() => {
    const set = new Set<string>();
    models.forEach((m) => capList(m.capabilities).forEach((c) => set.add(c)));
    return Array.from(set).sort();
  }, [models]);

  const filtered = models.filter((m) => {
    const provs = m.providerIds || (m.provider ? [m.provider] : []);
    if (providerFilter && !provs.includes(providerFilter)) return false;
    if (capFilter && !capList(m.capabilities).includes(capFilter)) return false;
    return true;
  });

  return (
    <div>
      <PageHeader title="Models" description="Models registered across all providers." />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        {providerOptions.length > 0 && (
          <Select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="sm:w-48" aria-label="Filter by provider">
            <option value="">All providers</option>
            {providerOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        )}
        {capOptions.length > 0 && (
          <Select value={capFilter} onChange={(e) => setCapFilter(e.target.value)} className="sm:w-48" aria-label="Filter by capability">
            <option value="">All capabilities</option>
            {capOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )}
      </div>

      {modelsQuery.loading ? (
        <SkeletonTable rows={6} cols={5} />
      ) : modelsQuery.error ? (
        <ErrorState message="Failed to load models." onRetry={modelsQuery.refetch} />
      ) : models.length === 0 ? (
        <EmptyState icon={Boxes} title="No models registered" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Boxes} title="No models match your filters" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Providers</th>
                  <th className="px-4 py-3 font-medium">Capabilities</th>
                  <th className="px-4 py-3 text-right font-medium">Requests</th>
                  <th className="px-4 py-3 text-right font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((m) => {
                  const provs = m.providerIds || (m.provider ? [m.provider] : []);
                  const u = usageByModel.get(m.id);
                  const caps = capList(m.capabilities);
                  return (
                    <tr key={m.id} className="hover:bg-muted/40">
                      <td className="px-4 py-3 font-medium text-foreground">{m.id}</td>
                      <td className="px-4 py-3 text-muted-foreground">{provs.join(', ') || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {caps.length ? (
                            caps.slice(0, 4).map((c) => (
                              <Badge key={c} tone="info">
                                {c}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCompact(u?.requests ?? 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCompact(u?.totalTokens ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
