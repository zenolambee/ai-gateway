'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { KeyRound, Plus, MoreVertical } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/misc';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ConfirmDialog } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useQuery } from '@/lib/use-query';
import { listApiKeys, revokeApiKey } from '@/lib/api';
import { formatCompact, formatDate, formatRelative } from '@/lib/utils';
import type { ApiKey } from '@/lib/types';

export default function ApiKeysPage() {
  const toast = useToast();
  const { data, loading, error, refetch } = useQuery(() => listApiKeys(), []);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const keys = useMemo(() => data || [], [data]);
  const providerOptions = useMemo(() => {
    const set = new Set<string>();
    keys.forEach((k) => k.allowedProviders?.forEach((p) => set.add(p)));
    return Array.from(set).sort();
  }, [keys]);
  const [providerFilter, setProviderFilter] = useState('');

  const filtered = useMemo(() => {
    return keys.filter((k) => {
      if (search && !`${k.name} ${k.keyPrefix}`.toLowerCase().includes(search.toLowerCase())) return false;
      if (statusFilter && k.status !== statusFilter) return false;
      if (providerFilter && !(k.allowedProviders || []).includes(providerFilter)) return false;
      return true;
    });
  }, [keys, search, statusFilter, providerFilter]);

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeApiKey(revokeTarget.id);
      toast.success('API key revoked', `${revokeTarget.name} will immediately stop working.`);
      setRevokeTarget(null);
      refetch();
    } catch (err) {
      toast.error('Unable to revoke API key.', err instanceof Error ? err.message : undefined);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Manage keys, permissions, quota and usage."
        actions={
          <Link href="/api-keys/new">
            <Button size="sm">
              <Plus className="h-4 w-4" aria-hidden />
              Create API Key
            </Button>
          </Link>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="Search by name or prefix…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
          aria-label="Search API keys"
        />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="sm:w-40" aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="revoked">Revoked</option>
          <option value="expired">Expired</option>
        </Select>
        {providerOptions.length > 0 && (
          <Select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="sm:w-40" aria-label="Filter by provider">
            <option value="">All providers</option>
            {providerOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={6} cols={7} />
      ) : error ? (
        <ErrorState message="Failed to load API keys." onRetry={refetch} />
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description="Create your first API key to start using the Gateway."
          action={
            <Link href="/api-keys/new">
              <Button size="sm">Create API Key</Button>
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={KeyRound} title="No keys match your filters" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Prefix</th>
                  <th className="px-4 py-3 font-medium">Providers</th>
                  <th className="px-4 py-3 font-medium">Quota</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last Used</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((k) => {
                  const limit = k.quota?.limit ?? null;
                  const used = k.quota?.used ?? 0;
                  const pct = limit && limit > 0 ? Math.round((used / limit) * 100) : null;
                  return (
                    <tr key={k.id} className="hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <Link href={`/api-keys/${encodeURIComponent(k.id)}`} className="font-medium text-primary hover:underline">
                          {k.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{k.keyPrefix}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {k.allowedProviders?.length ? k.allowedProviders.join(', ') : 'All'}
                      </td>
                      <td className="px-4 py-3">
                        {limit ? (
                          <div className="w-28">
                            <ProgressBar percent={pct} />
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatCompact(used)} / {formatCompact(limit)}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unlimited</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={k.status} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatRelative(k.lastUsed)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(k.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link href={`/api-keys/${encodeURIComponent(k.id)}`}>
                            <Button variant="ghost" size="sm">
                              View
                            </Button>
                          </Link>
                          {k.status !== 'revoked' && (
                            <Button variant="ghost" size="sm" className="text-danger" onClick={() => setRevokeTarget(k)}>
                              Revoke
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        title={revokeTarget ? `Revoke ${revokeTarget.name}?` : 'Revoke API key?'}
        message="This API key will immediately stop working. This action cannot be undone."
        confirmLabel="Revoke Key"
        danger
        loading={revoking}
      />
    </div>
  );
}
