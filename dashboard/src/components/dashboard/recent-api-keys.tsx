'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/misc';
import { listApiKeys } from '@/lib/api';
import { useQuery } from '@/lib/use-query';
import { formatCompact, formatRelative } from '@/lib/utils';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RecentApiKeys() {
  const { data, loading, error, refetch } = useQuery(() => listApiKeys(), []);
  const rows = (data || [])
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 6);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recent API Keys</CardTitle>
        <Link href="/api-keys" className="text-sm font-medium text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <SkeletonTable rows={5} cols={5} />
        ) : error ? (
          <ErrorState message="Unable to load API keys." onRetry={refetch} />
        ) : rows.length === 0 ? (
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
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Providers</th>
                  <th className="pb-2 font-medium">Quota</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Last Used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((k) => {
                  const limit = k.quota?.limit ?? null;
                  const used = k.quota?.used ?? 0;
                  const pct = limit && limit > 0 ? Math.round((used / limit) * 100) : null;
                  const providers = k.allowedProviders?.length ? k.allowedProviders.join(', ') : 'All';
                  return (
                    <tr key={k.id} className="hover:bg-muted/40">
                      <td className="py-2.5">
                        <Link href={`/api-keys/${encodeURIComponent(k.id)}`} className="font-medium text-primary hover:underline">
                          {k.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{k.keyPrefix}</p>
                      </td>
                      <td className="py-2.5 text-muted-foreground">{providers}</td>
                      <td className="py-2.5">
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
                      <td className="py-2.5">
                        <StatusBadge status={k.status} />
                      </td>
                      <td className="py-2.5 text-muted-foreground">{formatRelative(k.lastUsed)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
