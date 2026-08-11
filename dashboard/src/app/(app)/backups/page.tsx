'use client';

import { useState } from 'react';
import { Archive, Plus, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { createBackup, validateBackup, restoreBackup } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import type { BackupObject, RestoreReport } from '@/lib/types';

export default function BackupsPage() {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [backup, setBackup] = useState<BackupObject | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);

  async function doCreate() {
    setCreating(true);
    setReport(null);
    try {
      const res = await createBackup(true);
      setBackup(res.backup);
      const v = await validateBackup(res.backup);
      setValid(v.valid);
      toast.success('Backup created', v.valid ? 'Integrity verified.' : 'Warning: validation issues found.');
    } catch (err) {
      toast.error('Unable to create backup.', err instanceof Error ? err.message : undefined);
    } finally {
      setCreating(false);
    }
  }

  async function preview() {
    if (!backup) return;
    try {
      const r = await restoreBackup(backup, true);
      setReport(r);
      toast.info('Dry-run complete', 'Preview of changes generated.');
    } catch (err) {
      toast.error('Preview failed.', err instanceof Error ? err.message : undefined);
    }
  }

  async function doRestore() {
    if (!backup) return;
    setRestoring(true);
    try {
      const r = await restoreBackup(backup, false);
      setReport(r);
      if (r.ok || r.success) toast.success('Backup restored');
      else toast.error('Restore reported errors', (r.errors || []).join('; '));
      setRestoreOpen(false);
    } catch (err) {
      toast.error('Restore failed.', err instanceof Error ? err.message : undefined);
    } finally {
      setRestoring(false);
    }
  }

  function download() {
    if (!backup) return;
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-gateway-backup-v${backup.backupVersion}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader
        title="Backups"
        description="Create versioned, secret-free snapshots of gateway configuration."
        actions={
          <Button size="sm" onClick={doCreate} disabled={creating}>
            <Plus className="h-4 w-4" aria-hidden />
            {creating ? 'Creating…' : 'Create Backup'}
          </Button>
        }
      />

      {!backup ? (
        <EmptyState
          icon={Archive}
          title="No backup in this session"
          description="Create a backup to snapshot providers, API key metadata, quota and usage. Secrets are never included."
          action={
            <Button size="sm" onClick={doCreate} disabled={creating}>
              Create Backup
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Latest Backup</CardTitle>
              {valid != null && <Badge tone={valid ? 'success' : 'danger'}>{valid ? 'Integrity OK' : 'Invalid'}</Badge>}
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border text-sm">
                <Row label="Version" value={String(backup.backupVersion)} />
                <Row label="Created" value={formatDate(backup.createdAt as string | number)} />
                <Row label="Checksum" value={(backup.integrity?.checksum || backup.checksum || '—').slice(0, 16) + '…'} />
                <Row label="Providers" value={String(backup.data.providers?.length ?? 0)} />
                <Row label="API Keys (metadata)" value={String(backup.data.apiKeys?.length ?? 0)} />
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={download}>
                  Download
                </Button>
                <Button variant="outline" size="sm" onClick={preview}>
                  Preview Restore
                </Button>
                <Button variant="danger" size="sm" onClick={() => setRestoreOpen(true)}>
                  Restore
                </Button>
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                Secrets (plaintext keys, credentials) are never stored in backups.
              </p>
            </CardContent>
          </Card>

          {report && (
            <Card>
              <CardHeader>
                <CardTitle>{report.dryRun ? 'Restore Preview' : 'Restore Report'}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex flex-wrap gap-2">
                  <Badge tone={report.ok ? 'success' : 'danger'}>{report.ok ? 'OK' : 'Errors'}</Badge>
                  {typeof report.applied === 'number' && <Badge tone="info">{report.applied} applied</Badge>}
                  {report.dryRun && <Badge tone="warning">dry run</Badge>}
                </div>
                {report.warnings && report.warnings.length > 0 && (
                  <Section title="Warnings" items={report.warnings} tone="text-[hsl(32_81%_38%)]" />
                )}
                {report.skipped && report.skipped.length > 0 && (
                  <Section title="Skipped (secrets / non-restorable)" items={report.skipped} tone="text-muted-foreground" />
                )}
                {report.errors && report.errors.length > 0 && (
                  <Section title="Errors" items={report.errors} tone="text-danger" />
                )}
                {(!report.warnings?.length && !report.skipped?.length && !report.errors?.length) && (
                  <p className="text-sm text-muted-foreground">No warnings, skipped items or errors.</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <ConfirmDialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        onConfirm={doRestore}
        title="Restore this backup?"
        message="This operation may modify Gateway configuration (providers, API key metadata, quota). It cannot be undone."
        confirmLabel="Continue"
        danger
        loading={restoring}
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

function Section({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className={`list-inside list-disc space-y-0.5 text-sm ${tone}`}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
