'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Ban } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { ProgressBar, CopyButton } from '@/components/ui/misc';
import { StatCard } from '@/components/dashboard/stat-card';
import { SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useQuery } from '@/lib/use-query';
import { listApiKeys, getApiKeyUsage, revokeApiKey, rotateApiKey } from '@/lib/api';
import { formatCompact, formatDate, formatNumber, formatPercent, formatRelative } from '@/lib/utils';
import { Activity, Coins, Gauge, CheckCircle2 } from 'lucide-react';

export default function ApiKeyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const toast = useToast();

  const keyQuery = useQuery(async () => {
    const keys = await listApiKeys();
    return keys.find((k) => k.id === id) || null;
  }, [id]);
  const usageQuery = useQuery(() => getApiKeyUsage(id), [id]);

  const [revokeOpen, setRevokeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  const key = keyQuery.data;
  const usage = usageQuery.data;
  const analyticsUsage = (usage?.analytics?.usage || null) as
    | { requests?: number; totalTokens?: number; successRate?: number }
    | null;
  const quota = usage?.analytics?.quota || null;

  async function doRevoke() {
    setBusy(true);
    try {
      await revokeApiKey(id);
      toast.success('API key revoked');
      setRevokeOpen(false);
      keyQuery.refetch();
    } catch (err) {
      toast.error('Unable to revoke key.', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function doRotate() {
    setBusy(true);
    try {
      const res = await rotateApiKey(id);
      if (res.apiKey) setRotatedKey(res.apiKey);
      toast.success('API key rotated', 'A new secret has been generated.');
      keyQuery.refetch();
    } catch (err) {
      toast.error('Unable to rotate key.', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  if (keyQuery.loading) {
    return (
      <div>
        <PageHeader title="API Key" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }
  if (keyQuery.error || !key) {
    return (
      <div>
        <PageHeader title="API Key" />
        <ErrorState title="Key not found" message="This API key does not exist or could not be loaded." onRetry={keyQuery.refetch} />
      </div>
    );
  }

  const reqs = analyticsUsage?.requests ?? usage?.usage?.totalRequests ?? 0;
  const tokens = analyticsUsage?.totalTokens ?? usage?.usage?.totalTokens ?? 0;

  return (
    <div>
      <PageHeader
        title={key.name}
        description={key.keyPrefix}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/api-keys">
              <Button variant="outline" size="sm">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Back
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={doRotate} disabled={busy || key.status === 'revoked'}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Rotate
            </Button>
            {key.status !== 'revoked' && (
              <Button variant="danger" size="sm" onClick={() => setRevokeOpen(true)} disabled={busy}>
                <Ban className="h-4 w-4" aria-hidden />
                Revoke
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusBadge status={key.status} />
        <Badge tone="info">{key.role}</Badge>
        {key.expiresAt ? <Badge tone="neutral">Expires {formatDate(key.expiresAt)}</Badge> : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Requests" value={formatCompact(reqs)} icon={Activity} />
        <StatCard label="Tokens" value={formatCompact(tokens)} icon={Coins} tone="success" />
        <StatCard
          label="Quota Used"
          value={quota?.limit ? formatPercent(quota.percentageUsed) : '—'}
          hint={quota?.limit ? `${formatCompact(quota.used)} / ${formatCompact(quota.limit)}` : 'Unlimited'}
          icon={Gauge}
          tone="warning"
        />
        <StatCard
          label="Success Rate"
          value={analyticsUsage?.successRate != null ? formatPercent(analyticsUsage.successRate) : '—'}
          icon={CheckCircle2}
          tone="success"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Providers</p>
              <div className="flex flex-wrap gap-1.5">
                {key.allowedProviders?.length ? (
                  key.allowedProviders.map((p) => <Badge key={p} tone="neutral">{p}</Badge>)
                ) : (
                  <span className="text-sm text-muted-foreground">All providers</span>
                )}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Models</p>
              <div className="flex flex-wrap gap-1.5">
                {key.allowedModels?.length ? (
                  key.allowedModels.map((m) => <Badge key={m} tone="neutral">{m}</Badge>)
                ) : (
                  <span className="text-sm text-muted-foreground">All models</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quota</CardTitle>
          </CardHeader>
          <CardContent>
            {usageQuery.loading ? (
              <SkeletonTable rows={2} cols={2} />
            ) : quota?.limit ? (
              <div className="space-y-3">
                <ProgressBar percent={quota.percentageUsed} />
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xs text-muted-foreground">Used</p>
                    <p className="text-sm font-semibold">{formatNumber(quota.used)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Limit</p>
                    <p className="text-sm font-semibold">{formatNumber(quota.limit)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Remaining</p>
                    <p className="text-sm font-semibold">{formatNumber(quota.remaining ?? 0)}</p>
                  </div>
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  Reset: {quota.resetPeriod}
                  {quota.resetAt ? ` · next ${formatDate(quota.resetAt)}` : ''}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">This key has no quota limit configured.</p>
            )}
            <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
              Created {formatDate(key.createdAt)} · Last used {formatRelative(key.lastUsed)}
            </div>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={doRevoke}
        title={`Revoke ${key.name}?`}
        message="This API key will immediately stop working. This action cannot be undone."
        confirmLabel="Revoke Key"
        danger
        loading={busy}
      />

      <Modal open={!!rotatedKey} onClose={() => setRotatedKey(null)} title="API Key Rotated">
        <p className="text-sm text-muted-foreground">Copy the new key now — it will only be shown once.</p>
        <div className="mt-4 flex items-center gap-2">
          <code className="max-w-full overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">
            {rotatedKey}
          </code>
          {rotatedKey && <CopyButton value={rotatedKey} />}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={() => setRotatedKey(null)}>
            Done
          </Button>
        </div>
      </Modal>
    </div>
  );
}
