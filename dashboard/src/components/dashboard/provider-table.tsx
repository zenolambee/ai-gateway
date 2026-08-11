'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { getProviderUsage } from '@/lib/api';
import { useQuery } from '@/lib/use-query';
import { formatCompact, formatPercent } from '@/lib/utils';
import { Server } from 'lucide-react';

export function ProviderTable() {
  const { data, loading, error, refetch } = useQuery(() => getProviderUsage(), []);
  const rows = (data || []).filter((p) => p.requests > 0).slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Providers</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <SkeletonTable rows={4} cols={4} />
        ) : error ? (
          <ErrorState message="Unable to load provider usage." onRetry={refetch} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Server} title="No provider usage yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">Provider</th>
                  <th className="pb-2 text-right font-medium">Requests</th>
                  <th className="pb-2 text-right font-medium">Tokens</th>
                  <th className="pb-2 text-right font-medium">Success</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <tr key={p.providerId} className="hover:bg-muted/40">
                    <td className="py-2.5">
                      <Link href={`/providers/${encodeURIComponent(p.providerId)}`} className="font-medium text-primary hover:underline">
                        {p.providerId}
                      </Link>
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{formatCompact(p.requests)}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatCompact(p.totalTokens)}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatPercent(p.successRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
