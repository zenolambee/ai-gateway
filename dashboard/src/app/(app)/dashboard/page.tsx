'use client';

import Link from 'next/link';
import { KeyRound, Activity, Coins, CheckCircle2, Server } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/dashboard/stat-card';
import { UsageChart } from '@/components/dashboard/usage-chart';
import { ProviderTable } from '@/components/dashboard/provider-table';
import { RecentApiKeys } from '@/components/dashboard/recent-api-keys';
import { SystemHealthCard } from '@/components/dashboard/system-health-card';
import { SkeletonCard } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { getOverview, getUsageSummary } from '@/lib/api';
import { useQuery } from '@/lib/use-query';
import { formatCompact, formatNumber, formatPercent } from '@/lib/utils';

export default function DashboardPage() {
  const overview = useQuery(() => getOverview(), []);
  const summary = useQuery(() => getUsageSummary(), []);

  const o = overview.data;
  const s = summary.data;
  const loading = overview.loading || summary.loading;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Overview of your AI Gateway activity and health."
        actions={
          <Link href="/api-keys/new">
            <Button size="sm">
              <KeyRound className="h-4 w-4" aria-hidden />
              Create API Key
            </Button>
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <StatCard
              label="API Keys"
              value={formatNumber(o?.activeApiKeys ?? 0)}
              hint="Active"
              icon={KeyRound}
            />
            <StatCard
              label="Requests"
              value={formatCompact(o?.requests ?? 0)}
              hint={`${formatNumber(o?.successfulRequests ?? 0)} successful`}
              icon={Activity}
              tone="primary"
            />
            <StatCard
              label="Total Tokens"
              value={formatCompact(o?.tokens ?? 0)}
              hint={`${formatCompact(o?.promptTokens ?? 0)} in / ${formatCompact(o?.completionTokens ?? 0)} out`}
              icon={Coins}
              tone="success"
            />
            <StatCard
              label="Success Rate"
              value={
                o && o.requests > 0
                  ? formatPercent((o.successfulRequests / o.requests) * 100)
                  : '—'
              }
              hint={s ? `${formatNumber(s.entryCount)} recorded` : undefined}
              icon={CheckCircle2}
              tone="success"
            />
            <StatCard
              label="Providers"
              value={formatNumber(o?.healthyProviders ?? 0)}
              hint={`${formatNumber(o?.activeProviders ?? 0)} active`}
              icon={Server}
            />
          </>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <UsageChart />
        </div>
        <ProviderTable />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentApiKeys />
        </div>
        <SystemHealthCard />
      </div>
    </div>
  );
}
