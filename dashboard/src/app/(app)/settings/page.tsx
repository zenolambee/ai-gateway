'use client';

import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useQuery } from '@/lib/use-query';
import { getSystemInfo, getConfig, getLiveness } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/utils';

export default function SettingsPage() {
  const sys = useQuery(() => getSystemInfo(), []);
  const cfg = useQuery(() => getConfig(), []);
  const live = useQuery(() => getLiveness(), []);

  return (
    <div>
      <PageHeader title="Settings" description="Read-only view of runtime configuration reported by the backend." />

      {sys.loading ? (
        <SkeletonCard />
      ) : sys.error ? (
        <ErrorState message="Failed to load system information." onRetry={sys.refetch} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>General</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border text-sm">
                <Row label="Version" value={sys.data?.version || live.data?.version || '—'} />
                <Row label="Node" value={sys.data?.nodeVersion || '—'} />
                <Row label="Platform" value={`${sys.data?.platform || '—'} / ${sys.data?.arch || ''}`} />
                <Row label="Uptime" value={formatDuration(sys.data?.uptimeMs)} />
                <Row label="Process ID" value={String(sys.data?.pid ?? '—')} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runtime Memory</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border text-sm">
                <Row label="RSS" value={formatBytes(sys.data?.memory.rss)} />
                <Row label="Heap Total" value={formatBytes(sys.data?.memory.heapTotal)} />
                <Row label="Heap Used" value={formatBytes(sys.data?.memory.heapUsed)} />
                <Row label="External" value={formatBytes(sys.data?.memory.external)} />
              </dl>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Providers</CardTitle>
            </CardHeader>
            <CardContent>
              {cfg.loading ? (
                <SkeletonCard />
              ) : cfg.error ? (
                <ErrorState message="Failed to load provider config." onRetry={cfg.refetch} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(cfg.data?.providers || []).map((p) => (
                    <Badge key={p.id} tone={p.enabled ? 'success' : 'neutral'}>
                      {p.name} {p.enabled ? '' : '(disabled)'}
                    </Badge>
                  ))}
                  {(cfg.data?.providers || []).length === 0 && (
                    <p className="text-sm text-muted-foreground">No providers configured.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Provider credentials are masked and never exposed. Configuration edits are performed through provider config
        files / admin API endpoints.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-[60%] truncate font-medium text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}
