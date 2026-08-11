'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label, FieldError } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { CopyButton } from '@/components/ui/misc';
import { ProviderSelector } from '@/components/api-keys/provider-selector';
import { ModelSelector } from '@/components/api-keys/model-selector';
import { QuotaForm, emptyQuota, validateQuota, type QuotaFormValue } from '@/components/api-keys/quota-form';
import { useToast } from '@/components/ui/toast';
import { useQuery } from '@/lib/use-query';
import { listProviders, createApiKey } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import type { CreateApiKeyInput } from '@/lib/types';

type Step = 'details' | 'quota' | 'review' | 'done';
const STEPS: { key: Step; label: string }[] = [
  { key: 'details', label: 'Access' },
  { key: 'quota', label: 'Limits' },
  { key: 'review', label: 'Review' },
];

export default function CreateApiKeyPage() {
  const router = useRouter();
  const toast = useToast();
  const { data: providers, loading, error, refetch } = useQuery(() => listProviders(), []);

  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [quota, setQuota] = useState<QuotaFormValue>(emptyQuota);
  const quotaErrors = validateQuota(quota);
  const [submitting, setSubmitting] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  function nextFromDetails() {
    if (!name.trim()) {
      setNameError('A name is required.');
      return;
    }
    setNameError(null);
    setStep('quota');
  }

  function nextFromQuota() {
    if (Object.keys(quotaErrors).length > 0) return;
    setStep('review');
  }

  async function submit() {
    setSubmitting(true);
    try {
      const input: CreateApiKeyInput = { name: name.trim() };
      if (selectedProviders.length) input.allowedProviders = selectedProviders;
      if (selectedModels.length) input.allowedModels = selectedModels;
      if (quota.tokenLimit) input.quota = { limit: Number(quota.tokenLimit), reset: quota.resetPeriod };
      if (quota.rateLimit) input.rateLimit = { requestsPerMinute: Number(quota.rateLimit) };
      if (quota.expiration === 'custom' && quota.expiresAtDate) {
        input.expiresAt = Math.floor(Date.parse(quota.expiresAtDate) / 1000);
      }
      const res = await createApiKey(input);
      if (!res.apiKey) throw new Error('The backend did not return a one-time key.');
      setCreatedKey(res.apiKey);
      setStep('done');
      toast.success('API key created successfully.');
    } catch (err) {
      toast.error('Unable to create API key.', err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Create API Key" />
        <SkeletonCard />
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Create API Key" />
        <ErrorState message="Unable to load providers." onRetry={refetch} />
      </div>
    );
  }

  const providerList = providers || [];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Create API Key"
        actions={
          <Link href="/api-keys">
            <Button variant="outline" size="sm">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>
          </Link>
        }
      />

      {step !== 'done' && (
        <ol className="mb-6 flex items-center gap-2" aria-label="Progress">
          {STEPS.map((s, i) => {
            const idx = STEPS.findIndex((x) => x.key === step);
            const done = i < idx;
            const active = s.key === step;
            return (
              <li key={s.key} className="flex flex-1 items-center gap-2">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                    active
                      ? 'bg-primary text-primary-foreground'
                      : done
                        ? 'bg-success text-success-foreground'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {done ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span className={`text-sm font-medium ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {s.label}
                </span>
                {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden />}
              </li>
            );
          })}
        </ol>
      )}

      <Card>
        <CardContent className="pt-5">
          {step === 'details' && (
            <div className="space-y-6">
              <div className="space-y-1.5">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  placeholder="e.g. NVIDIA Production"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={!!nameError}
                  autoFocus
                />
                <FieldError>{nameError}</FieldError>
              </div>

              <div className="space-y-2">
                <Label>Allowed Providers</Label>
                <ProviderSelector providers={providerList} selected={selectedProviders} onChange={setSelectedProviders} />
              </div>

              <div className="space-y-2">
                <Label>Allowed Models</Label>
                <ModelSelector
                  providers={providerList}
                  selectedProviders={selectedProviders}
                  selectedModels={selectedModels}
                  onChange={setSelectedModels}
                />
              </div>

              <div className="flex justify-end">
                <Button onClick={nextFromDetails}>
                  Continue
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          )}

          {step === 'quota' && (
            <div className="space-y-6">
              <QuotaForm value={quota} errors={quotaErrors} onChange={setQuota} />
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep('details')}>
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Back
                </Button>
                <Button onClick={nextFromQuota} disabled={Object.keys(quotaErrors).length > 0}>
                  Continue
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-6">
              <dl className="divide-y divide-border rounded-md border border-border">
                <Row label="Name" value={name} />
                <Row label="Providers" value={selectedProviders.length ? selectedProviders.join(', ') : 'All providers'} />
                <Row label="Models" value={selectedModels.length ? `${selectedModels.length} selected` : 'All models'} />
                <Row label="Quota" value={quota.tokenLimit ? `${formatNumber(Number(quota.tokenLimit))} tokens` : 'Unlimited'} />
                <Row label="Reset" value={quota.tokenLimit ? quota.resetPeriod : '—'} />
                <Row label="Rate limit" value={quota.rateLimit ? `${quota.rateLimit} req/min` : 'None'} />
                <Row
                  label="Expiration"
                  value={quota.expiration === 'custom' && quota.expiresAtDate ? new Date(quota.expiresAtDate).toLocaleString() : 'Never'}
                />
              </dl>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep('quota')} disabled={submitting}>
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Back
                </Button>
                <Button onClick={submit} disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create API Key'}
                </Button>
              </div>
            </div>
          )}

          {step === 'done' && createdKey && (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                <Check className="h-6 w-6 text-success" aria-hidden />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">API Key Created</h2>
                <p className="mt-1 text-sm text-muted-foreground">Copy your key now — it will only be shown once.</p>
              </div>
              <div className="flex items-center justify-center gap-2">
                <code className="max-w-full overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">
                  {createdKey}
                </code>
                <CopyButton value={createdKey} label="Copy API Key" />
              </div>
              <div
                role="alert"
                className="rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-[hsl(32_81%_38%)]"
              >
                This key will only be shown once. Store it securely — it cannot be retrieved later.
              </div>
              <div className="flex justify-center gap-3">
                <Button variant="outline" onClick={() => router.push('/api-keys')}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}
