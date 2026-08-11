'use client';

import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonChart } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { getDailyUsage } from '@/lib/api';
import { useQuery } from '@/lib/use-query';
import { formatCompact, formatNumber } from '@/lib/utils';
import { BarChart3 } from 'lucide-react';

type Metric = 'requests' | 'tokens';
const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

interface Point {
  date: string;
  requests: number;
  tokens: number;
}

export function UsageChart() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<Metric>('requests');
  const { data, loading, error, refetch } = useQuery(() => getDailyUsage(days), [days]);

  const points: Point[] = useMemo(
    () =>
      (data || []).map((d) => ({
        date: d.date,
        requests: d.requests,
        tokens: d.totalTokens,
      })),
    [data],
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Usage Overview</CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="Metric">
            {(['requests', 'tokens'] as Metric[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={metric === m}
                onClick={() => setMetric(m)}
                className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                  metric === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Time range"
            className="h-8 rounded-md border border-input bg-card px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <SkeletonChart />
        ) : error ? (
          <ErrorState message="Unable to load usage data." onRetry={refetch} />
        ) : points.length === 0 ? (
          <EmptyState icon={BarChart3} title="No usage data yet" description="Usage will appear here once requests flow through the gateway." />
        ) : (
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillMetric" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(221 83% 53%)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="hsl(221 83% 53%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'hsl(215 16% 47%)' }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(215 16% 47%)' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => formatCompact(v)}
                  width={44}
                />
                <Tooltip
                  formatter={(value: number) => [formatNumber(value), metric === 'requests' ? 'Requests' : 'Tokens']}
                  contentStyle={{ borderRadius: 8, border: '1px solid hsl(214 32% 91%)', fontSize: 12 }}
                />
                <Area
                  type="monotone"
                  dataKey={metric}
                  stroke="hsl(221 83% 53%)"
                  strokeWidth={2}
                  fill="url(#fillMetric)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
