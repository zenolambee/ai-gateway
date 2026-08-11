'use client';

import { Plug } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useQuery } from '@/lib/use-query';
import { listConnections } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/utils';

export default function ConnectionsPage() {
  const { data, loading, error, refetch } = useQuery(() => listConnections(), []);
  const connections = data || [];

  return (
    <div>
      <PageHeader title="Connections" description="Provider accounts managed by the ConnectionManager." />

      {loading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : error ? (
        <ErrorState message="Failed to load connections." onRetry={refetch} />
      ) : connections.length === 0 ? (
        <EmptyState icon={Plug} title="No connections" description="No provider accounts are configured yet." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Auth Type</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last Used</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {connections.map((c) => {
                  const status = c.online != null ? (c.online ? 'online' : 'offline') : c.status || (c.enabled ? 'active' : 'disabled');
                  return (
                    <tr key={c.accountId} className="hover:bg-muted/40">
                      <td className="px-4 py-3 font-medium text-foreground">{c.providerId}</td>
                      <td className="px-4 py-3 text-muted-foreground">{c.name || c.accountId}</td>
                      <td className="px-4 py-3 text-muted-foreground">{c.authType || '—'}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatRelative(c.lastUsed)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(c.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Credentials are never exposed — only connection metadata is shown.
      </p>
    </div>
  );
}
