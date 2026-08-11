'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getProviderHealth, getSystemInfo, getLiveness } from '@/lib/api';
import { useQuery } from '@/lib/use-query';
import { cn } from '@/lib/utils';
import { Activity, Database, Server, HardDrive, Cpu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Health = 'healthy' | 'warning' | 'error' | 'unknown';

const DOT: Record<Health, string> = {
  healthy: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
  unknown: 'bg-muted-foreground',
};
const LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  error: 'Error',
  unknown: 'Unknown',
};

function Row({ icon: Icon, label, status, detail }: { icon: LucideIcon; label: string; status: Health; detail?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', DOT[status])} aria-hidden />
          <span className="text-xs font-medium text-muted-foreground">{LABEL[status]}</span>
        </span>
      </div>
    </div>
  );
}

export function SystemHealthCard() {
  const live = useQuery(() => getLiveness(), []);
  const sys = useQuery(() => getSystemInfo(), []);
  const health = useQuery(() => getProviderHealth(), []);

  const loading = live.loading || sys.loading || health.loading;

  const providers = health.data?.providers || {};
  const providerIds = Object.keys(providers);
  const online = providerIds.filter((id) => providers[id]?.online).length;
  let providerStatus: Health = 'unknown';
  if (providerIds.length > 0) {
    if (online === providerIds.length) providerStatus = 'healthy';
    else if (online === 0) providerStatus = 'error';
    else providerStatus = 'warning';
  }

  const apiStatus: Health = live.error ? 'error' : live.data ? 'healthy' : 'unknown';
  // The backend uses in-memory + optional Redis storage. We report a generic
  // "Storage" row from system info rather than inventing a DB/Redis probe.
  const storageStatus: Health = sys.error ? 'error' : sys.data ? 'healthy' : 'unknown';

  return (
    <Card>
      <CardHeader>
        <CardTitle>System Health</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border">
            <Row icon={Activity} label="API Server" status={apiStatus} detail={live.data ? `v${live.data.version}` : undefined} />
            <Row
              icon={Server}
              label="Provider Connections"
              status={providerStatus}
              detail={providerIds.length ? `${online}/${providerIds.length} online` : 'None'}
            />
            <Row icon={HardDrive} label="Storage" status={storageStatus} />
            <Row
              icon={Cpu}
              label="Runtime"
              status={sys.data ? 'healthy' : 'unknown'}
              detail={sys.data ? sys.data.nodeVersion : undefined}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
