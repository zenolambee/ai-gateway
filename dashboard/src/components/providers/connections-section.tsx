'use client';

import { useState } from 'react';
import { Plus, PlugZap, Pencil, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { Input, Label, FieldError } from '@/components/ui/input';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useQuery } from '@/lib/use-query';
import {
  listProviderConnections,
  addConnection,
  updateConnection,
  enableConnection,
  disableConnection,
  testConnection,
  deleteConnection,
} from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import type { Connection } from '@/lib/types';

/**
 * Connections section for the provider detail page.
 *
 * All credentials go through the backend ConnectionManager/EncryptionService.
 * The UI never persists secrets: the API key input is a password field whose
 * state is cleared immediately after submit, and the backend only ever
 * returns masked credential previews.
 */
export function ConnectionsSection({ providerId }: { providerId: string }) {
  const toast = useToast();
  const query = useQuery(() => listProviderConnections(providerId), [providerId]);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Connection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);
  const [disableTarget, setDisableTarget] = useState<Connection | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const connections = query.data || [];

  async function runTest(c: Connection) {
    const cid = c.id || c.accountId;
    setTestingId(cid);
    try {
      const res = await testConnection(providerId, cid);
      if (res.success) toast.success('Connection healthy', `${c.displayName || c.name || cid} responded in ${res.latencyMs}ms.`);
      else toast.error('Connection failed', res.error || 'The provider did not respond.');
      query.refetch();
    } catch (err) {
      toast.error('Test failed', err instanceof Error ? err.message : undefined);
    } finally {
      setTestingId(null);
    }
  }

  async function toggle(c: Connection, enable: boolean) {
    const cid = c.id || c.accountId;
    setBusyId(cid);
    try {
      if (enable) {
        await enableConnection(providerId, cid);
        toast.success('Connection enabled', `${c.displayName || c.name || cid} is now eligible for routing.`);
      } else {
        await disableConnection(providerId, cid);
        toast.success('Connection disabled', `${c.displayName || c.name || cid} will no longer receive requests.`);
      }
      query.refetch();
    } catch (err) {
      toast.error('Action failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
      setDisableTarget(null);
    }
  }

  async function doDelete() {
    if (!deleteTarget) return;
    const cid = deleteTarget.id || deleteTarget.accountId;
    setBusyId(cid);
    try {
      await deleteConnection(cid);
      toast.success('Connection deleted', `${deleteTarget.displayName || deleteTarget.name || cid} was removed.`);
      query.refetch();
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Connections ({connections.length})</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Add Connection
        </Button>
      </CardHeader>
      <CardContent>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connections yet. Add one to manage this provider&apos;s credentials via the ConnectionManager.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {connections.map((c) => {
              const cid = c.id || c.accountId;
              const active = c.enabled !== false;
              const healthy = (c.failureCount || 0) === 0 && (c.successCount || 0) > 0;
              return (
                <div key={cid} className="rounded-lg border border-border p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{c.displayName || c.name || cid}</p>
                      <p className="truncate text-xs text-muted-foreground">{cid}</p>
                    </div>
                    <StatusBadge status={active ? (healthy ? 'active' : c.status || 'active') : 'disabled'} />
                  </div>
                  <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <dt>API Key</dt>
                      <dd className="font-mono">{c.apiKey || '••••••••'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Health</dt>
                      <dd>
                        {c.successCount || c.failureCount
                          ? `${c.successCount || 0} ok / ${c.failureCount || 0} err${c.lastLatencyMs ? ` · ${Math.round(c.lastLatencyMs)}ms` : ''}`
                          : 'Not tested'}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Last used</dt>
                      <dd>{formatRelative(c.lastUsed)}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => runTest(c)} disabled={testingId === cid}>
                      <PlugZap className="h-3.5 w-3.5" aria-hidden />
                      {testingId === cid ? 'Testing...' : 'Test'}
                    </Button>
                    {active ? (
                      <Button size="sm" variant="outline" onClick={() => setDisableTarget(c)} disabled={busyId === cid}>
                        Disable
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => toggle(c, true)} disabled={busyId === cid}>
                        Enable
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setEditTarget(c)} aria-label={`Edit ${cid}`}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(c)} aria-label={`Delete ${cid}`}>
                      <Trash2 className="h-3.5 w-3.5 text-danger" aria-hidden />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Credentials are encrypted at rest via the EncryptionService and never returned in plaintext.
        </p>
      </CardContent>

      <ConnectionFormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        providerId={providerId}
        onSaved={() => query.refetch()}
      />

      <ConnectionFormModal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        providerId={providerId}
        connection={editTarget}
        onSaved={() => query.refetch()}
      />

      <ConfirmDialog
        open={!!disableTarget}
        onClose={() => setDisableTarget(null)}
        onConfirm={() => disableTarget && toggle(disableTarget, false)}
        title={`Disable ${disableTarget?.displayName || disableTarget?.name || disableTarget?.id}?`}
        message="Connection tidak akan menerima request baru dan tidak akan dipilih routing (priority/round-robin/weighted/least-used/random). Credential dan riwayat tetap tersimpan."
        confirmLabel="Disable"
        danger
        loading={busyId === (disableTarget?.id || disableTarget?.accountId)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={doDelete}
        title={`Delete ${deleteTarget?.displayName || deleteTarget?.name || deleteTarget?.id}?`}
        message="This will remove the connection and its stored credential. Historical usage is preserved."
        confirmLabel="Delete"
        danger
        loading={busyId === (deleteTarget?.id || deleteTarget?.accountId)}
      />
    </Card>
  );
}

function ConnectionFormModal({
  open,
  onClose,
  providerId,
  connection,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  providerId: string;
  connection?: Connection | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const editing = !!connection;
  const [connId, setConnId] = useState('');
  const [connName, setConnName] = useState('');
  const [key, setKey] = useState('');
  const [changeKey, setChangeKey] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Re-initialize when the target changes / modal opens.
  if (open && editing && connection && connId === '' && !saving) {
    setConnId(connection.id || connection.accountId);
    setConnName(connection.displayName || connection.name || '');
    setKey('');
    setChangeKey(false);
    setErrors({});
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (!editing) {
      if (!connId.trim()) next.id = 'Connection ID is required.';
      else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connId.trim())) next.id = 'Letters, digits, "-" and "_" only.';
      if (!key.trim()) next.key = 'Credential is required — stored server-side via the ConnectionManager.';
    } else if (changeKey && !key.trim()) {
      next.key = 'Enter the new API key, or cancel the change.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    try {
      if (editing && connection) {
        await updateConnection(connection.id || connection.accountId, {
          displayName: connName.trim() || undefined,
          ...(changeKey && key.trim() ? { apiKey: key.trim() } : {}),
        });
        toast.success('Connection updated', connName.trim() || connId);
      } else {
        await addConnection({
          id: connId.trim(),
          providerId,
          name: connName.trim() || undefined,
          apiKey: key.trim(),
        });
        toast.success('Connection added', `${connName.trim() || connId.trim()} is now connected to ${providerId}.`);
      }
      // Clear credential from state immediately after use.
      setKey('');
      setConnId('');
      setConnName('');
      setChangeKey(false);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(editing ? 'Update failed' : 'Add connection failed', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  function close() {
    setConnId('');
    setConnName('');
    setKey('');
    setChangeKey(false);
    setErrors({});
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? `Edit ${connection?.displayName || connection?.name || 'Connection'}` : 'Add Connection'}
      description={
        editing
          ? 'Update the connection. The stored credential is kept unless you replace it.'
          : `Connect a new credential to ${providerId} via the ConnectionManager.`
      }
    >
      <div className="space-y-4">
        <div>
          <Label>Provider</Label>
          <Input value={providerId} disabled aria-readonly />
        </div>
        <div>
          <Label htmlFor="conn-id">Connection ID</Label>
          <Input
            id="conn-id"
            value={connId}
            onChange={(e) => setConnId(e.target.value)}
            placeholder={`${providerId}-production`}
            disabled={editing}
            autoComplete="off"
          />
          <FieldError>{errors.id}</FieldError>
        </div>
        <div>
          <Label htmlFor="conn-name">Connection Name</Label>
          <Input
            id="conn-name"
            value={connName}
            onChange={(e) => setConnName(e.target.value)}
            placeholder="Production"
          />
        </div>
        <div>
          <Label htmlFor="conn-auth">Authentication</Label>
          <Input id="conn-auth" value="API Key" disabled aria-readonly />
        </div>
        {editing && !changeKey ? (
          <div>
            <Label>API Key</Label>
            <div className="flex items-center gap-2">
              <Input value={connection?.apiKey || '••••••••'} disabled aria-readonly className="font-mono" />
              <Button type="button" variant="outline" size="sm" onClick={() => setChangeKey(true)}>
                Change API Key
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Leave unchanged to keep the existing credential.
            </p>
          </div>
        ) : (
          <div>
            <Label htmlFor="conn-key">API Key</Label>
            <Input
              id="conn-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="new-password"
            />
            <FieldError>{errors.key}</FieldError>
            <p className="mt-1 text-xs text-muted-foreground">
              Sent to the backend over the admin channel only — never stored in the browser or logged.
            </p>
            {editing && (
              <Button type="button" variant="ghost" size="sm" className="mt-1" onClick={() => { setChangeKey(false); setKey(''); }}>
                Keep existing credential
              </Button>
            )}
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save Changes' : 'Save Connection'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
