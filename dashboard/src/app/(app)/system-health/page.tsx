'use client';

import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useQuery } from '@/lib/use-query';
import { getLiveness, getSystemInfo, getProviderHealth } from '@/lib/api';
import { cn, formatDuration } from '@/lib/utils';
import { Activity, Server, HardDrive, Cpu, Timer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Health = 'healthy' | 'warning' | 'error' | 'unknown';
const DOT: Record<Health, string> = {
  healthy: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
  unknown: 'bg-muted-foreground',
};
const LABEL: Record<Health, string> = { healthy: 'Healthy', warning: 'Warning', error: 'Error', unknown: 'Unknown' };

function HealthCard({
  icon: Icon,
  title,
  status,
  details,
}: {
  icon: LucideIcon;
  title: string;
  status: Health;
  details: { label: string; value: string }[];
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
          <CardTitle>{title}</CardTitle>
        </div>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('h-2.5 w-2.5 rounded-full', DOT[status])} aria-hidden />
          <span className="text-xs font-medium text-muted-foreground">{LABEL[status]}</span>
        </span>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border text-sm">
          {details.map((d) => (
            <div key={d.label} className="flex items-center justify-between py-2">
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd className="font-medium text-foreground">{d.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export default function SystemHealthPage() {
  const live = useQuery(() => getLiveness(), []);
  const sys = useQuery(() => getSystemInfo(), []);
  const health = useQuery(() => getProviderHealth(), []);

  const loading = live.loading && sys.loading && health.loading;
  if (loading) {
    return (
      <div>
        <PageHeader title="System Health" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (live.error && sys.error && health.error) {
    return (
      <div>
        <PageHeader title="System Health" />
        <ErrorState message="Unable to reach the gateway." onRetry={() => { live.refetch(); sys.refetch(); health.refetch(); }} />
      </div>
    );
  }

  const providers = health.data?.providers || {};
  const providerIds = Object.keys(providers);
  const online = providerIds.filter((id) => providers[id]?.online).length;
  let providerStatus: Health = 'unknown';
  if (providerIds.length > 0) providerStatus = online === providerIds.length ? 'healthy' : online === 0 ? 'error' : 'warning';

  return (
    <div>
      <PageHeader title="System Health" description="Live status of the gateway and its dependencies." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <HealthCard
          icon={Activity}
          title="API Server"
          status={live.error ? 'error' : live.data ? 'healthy' : 'unknown'}
          details={[
            { label: 'Version', value: live.data?.version || '—' },
            { label: 'Uptime', value: live.data ? formatDuration(live.data.uptime * 1000) : '—' },
          ]}
        />
        <HealthCard
          icon={Server}
          title="Provider Connections"
          status={providerStatus}
          details={[
            { label: 'Total', value: String(providerIds.length) },
            { label: 'Online', value: `${online}/${providerIds.length || 0}` },
          ]}
        />
        <HealthCard
          icon={HardDrive}
          title="Storage"
          status={sys.error ? 'error' : sys.data ? 'healthy' : 'unknown'}
          details={[{ label: 'Backend', value: 'In-memory / Redis (configurable)' }]}
        />
        <HealthCard
          icon={Cpu}
          title="Runtime"
          status={sys.data ? 'healthy' : 'unknown'}
          details={[
            { label: 'Node', value: sys.data?.nodeVersion || '—' },
            { label: 'Platform', value: sys.data ? `${sys.data.platform}/${sys.data.arch}` : '—' },
          ]}
        />
      </div>

      {providerIds.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Provider Detail</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 text-right font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {providerIds.map((id) => {
                    const h = providers[id];
                    return (
                      <tr key={id}>
                        <td className="py-2 font-medium text-foreground">{id}</td>
                        <td className="py-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={cn('h-2 w-2 rounded-full', h?.online ? 'bg-success' : 'bg-danger')} aria-hidden />
                            <span className="text-xs text-muted-foreground">{h?.online ? 'Online' : 'Offline'}</span>
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">
                          {h?.latencyMs != null ? (
                            <span className="inline-flex items-center gap-1">
                              <Timer className="h-3 w-3" aria-hidden />
                              {h.latencyMs}ms
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
