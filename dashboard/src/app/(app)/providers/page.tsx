'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Server, Plus, Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ConfirmDialog } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useQuery } from '@/lib/use-query';
import {
  listProviders,
  getProviderUsage,
  enableProvider,
  disableProvider,
} from '@/lib/api';
import { ProviderFormModal } from '@/components/providers/provider-form-modal';
import { cn, formatCompact, formatPercent } from '@/lib/utils';
import type { Provider } from '@/lib/types';

type Filter = 'all' | 'active' | 'disabled';

export default function ProvidersPage() {
  const toast = useToast();
  const providersQuery = useQuery(() => listProviders(), []);
  const usageQuery = useQuery(() => getProviderUsage(), []);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [disableTarget, setDisableTarget] = useState<Provider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const providers = useMemo(() => providersQuery.data || [], [providersQuery.data]);
  const usageById = new Map((usageQuery.data || []).map((u) => [u.providerId, u]));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((p) => {
      if (filter === 'active' && !p.enabled) return false;
      if (filter === 'disabled' && p.enabled) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.supportedModels || []).some((m) => m.toLowerCase().includes(q))
      );
    });
  }, [providers, search, filter]);

  async function toggle(p: Provider, enable: boolean) {
    setBusyId(p.id);
    try {
      if (enable) {
        await enableProvider(p.id);
        toast.success('Provider enabled', `${p.name} is now eligible for routing.`);
      } else {
        await disableProvider(p.id);
        toast.success('Provider disabled', `${p.name} will no longer receive new requests.`);
      }
      providersQuery.refetch();
    } catch (err) {
      toast.error('Action failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
      setDisableTarget(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Providers"
        description="Upstream providers registered in the gateway."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Add Provider
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search providers..."
            className="pl-9"
            aria-label="Search providers"
          />
        </div>
        <div className="flex gap-1 rounded-md border border-border bg-card p-1">
          {(['all', 'active', 'disabled'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {providersQuery.loading ? (
        <SkeletonTable rows={5} cols={7} />
      ) : providersQuery.error ? (
        <ErrorState message="Failed to load providers." onRetry={providersQuery.refetch} />
      ) : providers.length === 0 ? (
        <EmptyState icon={Server} title="No providers connected" description="Add a provider to start routing requests." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="No matches" description="No providers match the current search or filter." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Models</th>
                  <th className="px-4 py-3 font-medium">Connections</th>
                  <th className="px-4 py-3 text-right font-medium">Requests</th>
                  <th className="px-4 py-3 text-right font-medium">Success</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((p) => {
                  const u = usageById.get(p.id);
                  const status = p.health?.online === false ? 'offline' : p.enabled ? 'active' : 'disabled';
                  return (
                    <tr key={p.id} className="hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <Link href={`/providers/${encodeURIComponent(p.id)}`} className="font-medium text-primary hover:underline">
                          {p.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{p.id} · {p.adapter || 'generic-openai'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{p.supportedModels?.length || 0}</td>
                      <td className="px-4 py-3 text-muted-foreground">{p.connections ?? 0}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCompact(u?.requests ?? 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{u ? formatPercent(u.successRate) : '—'}</td>
                      <td className="px-4 py-3 text-right">
                        {p.enabled ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === p.id}
                            onClick={() => setDisableTarget(p)}
                          >
                            Disable
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === p.id}
                            onClick={() => toggle(p, true)}
                          >
                            Enable
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ProviderFormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => providersQuery.refetch()}
      />

      <ConfirmDialog
        open={!!disableTarget}
        onClose={() => setDisableTarget(null)}
        onConfirm={() => disableTarget && toggle(disableTarget, false)}
        title={`Disable ${disableTarget?.name}?`}
        message="Provider tidak akan menerima request baru dan tidak akan dipilih oleh routing. Model, koneksi, credential, permission API key, dan riwayat usage tetap tersimpan."
        confirmLabel="Disable"
        cancelLabel="Cancel"
        danger
        loading={busyId === disableTarget?.id}
      />
    </div>
  );
}
