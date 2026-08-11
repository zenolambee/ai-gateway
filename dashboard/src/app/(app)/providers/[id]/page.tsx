'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, PlugZap, Pencil, Trash2, Activity, Coins, CheckCircle2, Timer } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { StatCard } from '@/components/dashboard/stat-card';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { ConfirmDialog } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useQuery } from '@/lib/use-query';
import {
  getProviderDetail,
  testProvider,
  enableProvider,
  disableProvider,
  deleteProvider,
} from '@/lib/api';
import { ProviderFormModal } from '@/components/providers/provider-form-modal';
import { ConnectionsSection } from '@/components/providers/connections-section';
import { formatCompact, formatPercent, formatRelative } from '@/lib/utils';

export default function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const detailQuery = useQuery(() => getProviderDetail(id), [id]);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const provider = detailQuery.data?.provider;
  const usage = detailQuery.data?.usage;

  async function runTest() {
    setTesting(true);
    try {
      const res = await testProvider(id);
      if (res.success) toast.success('Connection OK', `Responded in ${res.latencyMs}ms.`);
      else toast.error('Connection failed', res.error || 'The provider did not respond.');
    } catch (err) {
      toast.error('Test failed', err instanceof Error ? err.message : undefined);
    } finally {
      setTesting(false);
    }
  }

  async function toggle(enable: boolean) {
    setBusy(true);
    try {
      if (enable) {
        await enableProvider(id);
        toast.success('Provider enabled', 'The provider is now eligible for routing.');
      } else {
        await disableProvider(id);
        toast.success('Provider disabled', 'The provider will no longer receive new requests.');
      }
      detailQuery.refetch();
    } catch (err) {
      toast.error('Action failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
      setDisableOpen(false);
    }
  }

  async function doDelete() {
    setBusy(true);
    try {
      await deleteProvider(id);
      toast.success('Provider deleted', `${provider?.name || id} was removed.`);
      router.push('/providers');
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : undefined);
      setBusy(false);
      setDeleteOpen(false);
    }
  }

  if (detailQuery.loading) {
    return (
      <div>
        <PageHeader title="Provider" />
        <SkeletonCard />
      </div>
    );
  }
  if (detailQuery.error || !provider) {
    return (
      <div>
        <PageHeader title="Provider" />
        <ErrorState title="Provider not found" onRetry={detailQuery.refetch} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={provider.name}
        description={`${provider.id} · ${provider.adapter || 'generic-openai'}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/providers">
              <Button variant="outline" size="sm">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Back
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
              <PlugZap className="h-4 w-4" aria-hidden />
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>
            {provider.enabled ? (
              <Button size="sm" variant="danger" onClick={() => setDisableOpen(true)} disabled={busy}>
                Disable Provider
              </Button>
            ) : (
              <Button size="sm" onClick={() => toggle(true)} disabled={busy}>
                Enable Provider
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)} disabled={busy} aria-label="Delete provider">
              <Trash2 className="h-4 w-4 text-danger" aria-hidden />
            </Button>
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusBadge status={provider.enabled ? 'active' : 'disabled'} />
        {provider.health?.online != null && <StatusBadge status={provider.health.online ? 'online' : 'offline'} />}
        {typeof provider.priority === 'number' && <Badge tone="neutral">priority {provider.priority}</Badge>}
        {!provider.enabled && provider.disabledReason && <Badge tone="neutral">{provider.disabledReason}</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Requests" value={formatCompact(usage?.requests ?? 0)} icon={Activity} />
        <StatCard label="Tokens" value={formatCompact(usage?.totalTokens ?? 0)} icon={Coins} tone="success" />
        <StatCard
          label="Success Rate"
          value={usage ? formatPercent(usage.successRate) : '—'}
          icon={CheckCircle2}
          tone="success"
        />
        <StatCard
          label="Avg Latency"
          value={usage && usage.averageLatencyMs ? `${Math.round(usage.averageLatencyMs)}ms` : '—'}
          icon={Timer}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Information</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              <Row label="ID" value={provider.id} />
              <Row label="Endpoint" value={provider.baseURL || '—'} />
              <Row label="Adapter" value={provider.adapter || 'generic-openai'} />
              <Row label="Timeout" value={provider.timeout ? `${provider.timeout}ms` : '—'} />
              <Row label="Weight" value={String(provider.weight ?? 1)} />
              <Row label="Fallback" value={provider.fallbackPolicy === false ? 'Disabled' : 'Enabled'} />
              <Row
                label="Credentials"
                value={provider.apiKeys?.length ? `${provider.apiKeys.length} configured (masked)` : 'None'}
              />
              <Row label="Created" value={provider.createdAt ? formatRelative(provider.createdAt) : '—'} />
              <Row label="Updated" value={provider.updatedAt ? formatRelative(provider.updatedAt) : '—'} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Available Models ({provider.supportedModels?.length || 0})</CardTitle>
          </CardHeader>
          <CardContent>
            {provider.supportedModels?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {provider.supportedModels.map((m) => (
                  <Badge key={m} tone="neutral">
                    {m}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No models registered for this provider.</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Models stay linked to this provider even while it is disabled.
            </p>
          </CardContent>
        </Card>
      </div>

      <ConnectionsSection providerId={provider.id} />

      <ProviderFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={() => detailQuery.refetch()}
        provider={provider}
      />

      <ConfirmDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirm={() => toggle(false)}
        title={`Disable ${provider.name}?`}
        message="Provider tidak akan menerima request baru dan tidak akan dipilih oleh routing. Model, koneksi, credential, permission API key, dan riwayat usage tetap tersimpan."
        confirmLabel="Disable"
        cancelLabel="Cancel"
        danger
        loading={busy}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={doDelete}
        title={`Delete ${provider.name}?`}
        message="Penghapusan bersifat permanen dan DITOLAK jika provider masih memiliki koneksi aktif, permission API key, atau riwayat usage. Pertimbangkan Disable sebagai gantinya."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        loading={busy}
      />

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
