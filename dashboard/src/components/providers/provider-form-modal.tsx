'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input, Select, Label, FieldError } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { createProvider, updateProvider, listAdapters } from '@/lib/api';
import type { Provider } from '@/lib/types';

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Add / Edit provider modal.
 *
 * Credentials are sent to the backend admin API exactly once (over the
 * authenticated same-origin proxy) and are NEVER persisted in the browser
 * (no localStorage, no state reuse after submit). The backend stores them
 * via the existing provider config / ConnectionManager secret handling and
 * only ever returns masked values.
 */
export function ProviderFormModal({
  open,
  onClose,
  onSaved,
  provider,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** When set, the modal edits this provider; otherwise it creates one. */
  provider?: Provider | null;
}) {
  const toast = useToast();
  const editing = !!provider;

  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [adapter, setAdapter] = useState('generic-openai');
  const [enabled, setEnabled] = useState(true);
  const [modelsText, setModelsText] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [adapters, setAdapters] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setId(provider?.id || '');
    setName(provider?.name || '');
    setBaseURL(provider?.baseURL || '');
    setAdapter(provider?.adapter || 'generic-openai');
    setEnabled(provider?.enabled !== false);
    setModelsText((provider?.supportedModels || []).join('\n'));
    setApiKey('');
    setErrors({});
    listAdapters()
      .then(setAdapters)
      .catch(() => setAdapters([]));
  }, [open, provider]);

  const adapterOptions = useMemo(() => {
    const set = new Set(adapters);
    set.add('generic-openai');
    if (adapter) set.add(adapter);
    return [...set].sort();
  }, [adapters, adapter]);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!editing) {
      if (!id.trim()) next.id = 'Provider ID is required.';
      else if (!ID_RE.test(id.trim())) next.id = 'Use lowercase letters, digits, "-" and "_" (start with a letter or digit).';
    }
    if (!name.trim()) next.name = 'Name is required.';
    if (!baseURL.trim()) next.baseURL = 'Base URL is required.';
    else {
      try {
        const u = new URL(baseURL.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') next.baseURL = 'URL must use http or https.';
      } catch {
        next.baseURL = 'Enter a valid URL (e.g. https://api.example.com/v1).';
      }
    }
    const models = modelsText.split('\n').map((m) => m.trim()).filter(Boolean);
    if (models.length === 0) next.models = 'Add at least one model (one per line).';
    else if (new Set(models).size !== models.length) next.models = 'Duplicate model ids are not allowed.';
    if (!editing && !apiKey.trim()) {
      next.apiKey = 'An initial credential is required. It is sent to the backend only and never stored in the browser.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setSaving(true);
    try {
      const models = modelsText.split('\n').map((m) => m.trim()).filter(Boolean);
      if (editing && provider) {
        await updateProvider(provider.id, {
          name: name.trim(),
          baseURL: baseURL.trim(),
          adapter,
          enabled,
          supportedModels: models,
          ...(apiKey.trim() ? { apiKeys: [apiKey.trim()] } : {}),
        });
        toast.success('Provider updated', `${name.trim()} was saved.`);
      } else {
        await createProvider({
          id: id.trim(),
          name: name.trim(),
          baseURL: baseURL.trim(),
          adapter,
          enabled,
          supportedModels: models,
          apiKey: apiKey.trim(),
        });
        toast.success('Provider added', `${name.trim()} is now registered.`);
      }
      // Clear the credential from component state immediately after use.
      setApiKey('');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(editing ? 'Update failed' : 'Create failed', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${provider?.name || 'Provider'}` : 'Add Provider'}
      description={
        editing
          ? 'Update the provider configuration. Leave the credential empty to keep the existing one.'
          : 'Register a new upstream provider. The credential is stored server-side only.'
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="prov-id">Provider ID</Label>
          <Input
            id="prov-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="nvidia"
            disabled={editing}
            autoComplete="off"
          />
          <FieldError>{errors.id}</FieldError>
        </div>

        <div>
          <Label htmlFor="prov-name">Provider Name</Label>
          <Input id="prov-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="NVIDIA NIM" />
          <FieldError>{errors.name}</FieldError>
        </div>

        <div>
          <Label htmlFor="prov-url">Base URL</Label>
          <Input
            id="prov-url"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://integrate.api.nvidia.com/v1"
            autoComplete="off"
          />
          <FieldError>{errors.baseURL}</FieldError>
        </div>

        <div>
          <Label htmlFor="prov-adapter">API Format / Protocol</Label>
          <Select id="prov-adapter" value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            {adapterOptions.map((a) => (
              <option key={a} value={a}>
                {a === 'generic-openai' ? 'generic-openai (OpenAI Compatible)' : a}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            Only registered adapters are accepted — the gateway never creates fake adapters.
          </p>
        </div>

        <div>
          <Label htmlFor="prov-models">Models (one per line)</Label>
          <textarea
            id="prov-models"
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            rows={4}
            placeholder={'moonshotai/kimi-k2-instruct\nmeta/llama-3.3-70b-instruct'}
            className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <FieldError>{errors.models}</FieldError>
        </div>

        <div>
          <Label htmlFor="prov-key">{editing ? 'Credential / API Key (optional — replaces existing)' : 'Credential / API Key'}</Label>
          <Input
            id="prov-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing ? '••••••••' : 'sk-...'}
            autoComplete="new-password"
          />
          <FieldError>{errors.apiKey}</FieldError>
          <p className="mt-1 text-xs text-muted-foreground">
            Sent to the backend over the admin channel only — never stored in the browser or logged.
          </p>
        </div>

        <div>
          <Label htmlFor="prov-status">Status</Label>
          <Select id="prov-status" value={enabled ? 'active' : 'disabled'} onChange={(e) => setEnabled(e.target.value === 'active')}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save Changes' : 'Add Provider'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
