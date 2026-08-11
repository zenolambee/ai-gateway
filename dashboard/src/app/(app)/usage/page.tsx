'use client';

import { useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/dashboard/stat-card';
import { UsageChart } from '@/components/dashboard/usage-chart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonCard, SkeletonChart, SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useQuery } from '@/lib/use-query';
import { getUsageSummary, getProviderUsage, getModelUsage } from '@/lib/api';
import { formatCompact, formatNumber, formatPercent } from '@/lib/utils';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Coins, CheckCircle2, Timer } from 'lucide-react';

const PIE_COLORS = ['hsl(221 83% 53%)', 'hsl(142 71% 45%)', 'hsl(38 92% 50%)', 'hsl(0 72% 51%)', 'hsl(262 83% 58%)', 'hsl(190 90% 42%)'];

export default function UsagePage() {
  const summaryQuery = useQuery(() => getUsageSummary(), []);
  const providerQuery = useQuery(() => getProviderUsage(), []);
  const modelQuery = useQuery(() => getModelUsage(), []);
  const [tab, setTab] = useState<'providers' | 'models'>('providers');

  const s = summaryQuery.data;

  const providerRows = (providerQuery.data || []).filter((p) => p.requests > 0);
  const modelRows = (modelQuery.data || []).filter((m) => m.requests > 0);

  const statusData = s
    ? [
        { name: 'Success', value: s.successfulRequests },
        { name: 'Error', value: s.failedRequests },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <div>
      <PageHeader title="Usage & Analytics" description="Aggregate usage across keys, providers, and models." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {summaryQuery.loading ? (
          Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
        ) : summaryQuery.error ? (
          <div className="sm:col-span-2 xl:col-span-6">
            <ErrorState message="Failed to load analytics." onRetry={summaryQuery.refetch} />
          </div>
        ) : (
          <>
            <StatCard label="Requests" value={formatCompact(s?.requests ?? 0)} icon={Activity} />
            <StatCard label="Input Tokens" value={formatCompact(s?.inputTokens ?? 0)} icon={ArrowDownToLine} />
            <StatCard label="Output Tokens" value={formatCompact(s?.outputTokens ?? 0)} icon={ArrowUpFromLine} />
            <StatCard label="Total Tokens" value={formatCompact(s?.totalTokens ?? 0)} icon={Coins} tone="success" />
            <StatCard label="Success Rate" value={formatPercent(s?.successRate)} icon={CheckCircle2} tone="success" />
            <StatCard label="Avg Latency" value={s ? `${formatNumber(s.averageLatencyMs)}ms` : '—'} icon={Timer} tone="warning" />
          </>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <UsageChart />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Success / Error</CardTitle>
          </CardHeader>
          <CardContent>
            {summaryQuery.loading ? (
              <SkeletonChart />
            ) : statusData.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="No requests yet" />
            ) : (
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      <Cell fill="hsl(142 71% 45%)" />
                      <Cell fill="hsl(0 72% 51%)" />
                    </Pie>
                    <Tooltip formatter={(v: number) => formatNumber(v)} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex rounded-md border border-border p-0.5" role="tablist" aria-label="Breakdown">
          {(['providers', 'models'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded px-3 py-1.5 text-sm font-medium capitalize sm:flex-none ${
                tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'providers' ? (
          <BreakdownChartTable
            loading={providerQuery.loading}
            error={!!providerQuery.error}
            onRetry={providerQuery.refetch}
            rows={providerRows.map((p) => ({ key: p.providerId, label: p.providerId, requests: p.requests, tokens: p.totalTokens, successRate: p.successRate }))}
            title="Provider Usage"
          />
        ) : (
          <BreakdownChartTable
            loading={modelQuery.loading}
            error={!!modelQuery.error}
            onRetry={modelQuery.refetch}
            rows={modelRows.map((m) => ({ key: m.model, label: m.model, requests: m.requests, tokens: m.totalTokens, successRate: m.successRate }))}
            title="Model Usage"
          />
        )}
      </div>
    </div>
  );
}

interface Row {
  key: string;
  label: string;
  requests: number;
  tokens: number;
  successRate: number;
}

function BreakdownChartTable({
  loading,
  error,
  onRetry,
  rows,
  title,
}: {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  rows: Row[];
  title: string;
}) {
  if (loading) return <SkeletonTable rows={5} cols={4} />;
  if (error) return <ErrorState message="Failed to load usage data." onRetry={onRetry} />;
  if (rows.length === 0) return <EmptyState icon={Activity} title="No usage data yet" />;

  const chartData = rows.slice(0, 8);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: 'hsl(215 16% 47%)' }} tickFormatter={(v: number) => formatCompact(v)} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: 'hsl(215 16% 47%)' }} width={100} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: number) => formatNumber(v)} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="requests" radius={[0, 4, 4, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 text-right font-medium">Requests</th>
                <th className="px-4 py-3 text-right font-medium">Tokens</th>
                <th className="px-4 py-3 text-right font-medium">Success</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.key} className="hover:bg-muted/40">
                  <td className="px-4 py-2.5 font-medium text-foreground">{r.label}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatCompact(r.requests)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatCompact(r.tokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatPercent(r.successRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
