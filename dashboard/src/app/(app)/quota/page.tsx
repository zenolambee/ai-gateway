'use client';

import { Gauge } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/misc';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useQuery } from '@/lib/use-query';
import { listApiKeys } from '@/lib/api';
import { formatCompact, formatNumber, formatPercent } from '@/lib/utils';

export default function QuotaPage() {
  const { data, loading, error, refetch } = useQuery(() => listApiKeys(), []);
  const rows = (data || []).filter((k) => k.quota && k.quota.limit != null);

  return (
    <div>
      <PageHeader title="Quota" description="Per-key quota consumption. The backend remains the source of truth." />

      {loading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <ErrorState message="Failed to load quota data." onRetry={refetch} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Gauge} title="No quota-limited keys" description="Keys without a token limit are unlimited." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">API Key</th>
                  <th className="px-4 py-3 text-right font-medium">Limit</th>
                  <th className="px-4 py-3 text-right font-medium">Used</th>
                  <th className="px-4 py-3 text-right font-medium">Remaining</th>
                  <th className="px-4 py-3 font-medium">Usage</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((k) => {
                  const limit = k.quota!.limit!;
                  const used = k.quota!.used;
                  const remaining = k.quota!.remaining ?? Math.max(0, limit - used);
                  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
                  return (
                    <tr key={k.id} className="hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <span className="font-medium text-foreground">{k.name}</span>
                        <p className="font-mono text-xs text-muted-foreground">{k.keyPrefix}</p>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatNumber(limit)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCompact(used)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCompact(remaining)}</td>
                      <td className="px-4 py-3">
                        <div className="w-40">
                          <ProgressBar percent={pct} />
                          <p className="mt-1 text-xs text-muted-foreground">{formatPercent(pct, 0)}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={k.status} />
                      </td>
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
