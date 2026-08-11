'use client';

import { ScrollText } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useQuery } from '@/lib/use-query';
import { getLogs } from '@/lib/api';
import { formatDate } from '@/lib/utils';

function statusTone(status?: number): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status == null) return 'neutral';
  if (status < 400) return 'success';
  if (status < 500) return 'warning';
  return 'danger';
}

export default function LogsPage() {
  const { data, loading, error, refetch } = useQuery(() => getLogs(150), []);
  const entries = data || [];

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Recent request log entries from the gateway."
        actions={
          <Button variant="outline" size="sm" onClick={refetch}>
            Refresh
          </Button>
        }
      />

      {loading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : error ? (
        <ErrorState message="Failed to load logs." onRetry={refetch} />
      ) : entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="No log entries" description="Request activity will appear here as it happens." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">API Key</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((e, i) => (
                  <tr key={e.requestId || e.seq || i} className="hover:bg-muted/40">
                    <td className="px-4 py-2.5 text-muted-foreground">{formatDate(e.timestamp)}</td>
                    <td className="px-4 py-2.5">{e.providerId || '—'}</td>
                    <td className="px-4 py-2.5">{e.model || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{e.apiKeyId || '—'}</td>
                    <td className="px-4 py-2.5">
                      {e.status != null ? <Badge tone={statusTone(e.status)}>{e.status}</Badge> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
