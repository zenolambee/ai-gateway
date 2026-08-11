'use client';

import { useMemo, useState } from 'react';
import { Route, Plus, Trash2, Pencil } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select, Label } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { useQuery } from '@/lib/use-query';
import {
  getRoutingConfig,
  updateRoutingConfig,
  getRoutingStatus,
  getRoutingActivity,
  listRoutingRules,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,
  listProviders,
  listModels,
  listConnections,
} from '@/lib/api';
import type { ModelRoutingRule } from '@/lib/types';
import { formatRelative } from '@/lib/utils';

const CORE_STRATEGIES = ['priority', 'round-robin', 'least-used', 'weighted', 'random'] as const;

function strategyLabel(id: string): string {
  switch (id) {
    case 'round-robin': return 'Round-Robin';
    case 'least-used': return 'Least Used';
    case 'fastest-response': return 'Fastest Response';
    case 'lowest-latency': return 'Lowest Latency';
    case 'lowest-cost': return 'Lowest Cost';
    case 'highest-success-rate': return 'Highest Success Rate';
    default: return id.charAt(0).toUpperCase() + id.slice(1);
  }
}

export default function RoutingPage() {
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);

  const configQ = useQuery(() => getRoutingConfig(), []);
  const statusQ = useQuery(() => getRoutingStatus(), []);
  const activityQ = useQuery(() => getRoutingActivity(50), []);
  const rulesQ = useQuery(() => listRoutingRules(), []);
  const providersQ = useQuery(() => listProviders(), []);
  const modelsQ = useQuery(() => listModels(), []);
  const connectionsQ = useQuery(() => listConnections(), []);

  const config = configQ.data;
  const descriptions = config?.strategyDescriptions || {};

  async function applyScope(field: 'strategy' | 'connectionStrategy' | 'keySelectionStrategy', value: string) {
    setSaving(field);
    try {
      await updateRoutingConfig({ [field]: value });
      toast.success('Routing updated', `${strategyLabel(value)} applied — effective immediately, no restart needed.`);
      configQ.refetch();
      statusQ.refetch();
    } catch (e) {
      toast.error('Failed to update routing', e instanceof Error ? e.message : undefined);
      configQ.refetch();
    } finally {
      setSaving(null);
    }
  }

  // ---- Model routing rule editor ----
  const [ruleModal, setRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<ModelRoutingRule | null>(null);
  const [ruleModel, setRuleModel] = useState('');
  const [ruleProvider, setRuleProvider] = useState('');
  const [ruleStrategy, setRuleStrategy] = useState('round-robin');
  const [ruleConnections, setRuleConnections] = useState<string[]>([]);
  const [ruleSaving, setRuleSaving] = useState(false);

  const providerConnections = useMemo(() => {
    const all = connectionsQ.data || [];
    return ruleProvider ? all.filter((c) => c.providerId === ruleProvider) : [];
  }, [connectionsQ.data, ruleProvider]);

  function openNewRule() {
    setEditingRule(null);
    setRuleModel('');
    setRuleProvider('');
    setRuleStrategy('round-robin');
    setRuleConnections([]);
    setRuleModal(true);
  }

  function openEditRule(rule: ModelRoutingRule) {
    setEditingRule(rule);
    setRuleModel(rule.model);
    setRuleProvider((rule.providerOrder && rule.providerOrder[0]) || '');
    setRuleStrategy(rule.strategy || 'round-robin');
    setRuleConnections(rule.connectionIds || []);
    setRuleModal(true);
  }

  async function saveRule() {
    if (!ruleModel) {
      toast.error('Model is required');
      return;
    }
    setRuleSaving(true);
    try {
      const payload = {
        model: ruleModel,
        strategy: ruleStrategy,
        providerOrder: ruleProvider ? [ruleProvider] : undefined,
        connectionIds: ruleConnections.length > 0 ? ruleConnections : undefined,
        enabled: true,
      };
      if (editingRule) {
        await updateRoutingRule(editingRule.id, payload);
        toast.success('Rule updated');
      } else {
        await createRoutingRule(payload);
        toast.success('Rule created', 'Effective immediately for the next request.');
      }
      setRuleModal(false);
      rulesQ.refetch();
    } catch (e) {
      toast.error('Failed to save rule', e instanceof Error ? e.message : undefined);
    } finally {
      setRuleSaving(false);
    }
  }

  async function removeRule(rule: ModelRoutingRule) {
    try {
      await deleteRoutingRule(rule.id);
      toast.success('Rule deleted');
      rulesQ.refetch();
    } catch (e) {
      toast.error('Failed to delete rule', e instanceof Error ? e.message : undefined);
    }
  }

  function StrategySelect({
    id, label, value, options, onChange, disabled,
  }: {
    id: string; label: string; value: string; options: string[];
    onChange: (v: string) => void; disabled: boolean;
  }) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {options.map((s) => (
            <option key={s} value={s}>{strategyLabel(s)}</option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{descriptions[value] || ''}</p>
      </div>
    );
  }

  const loading = configQ.loading || statusQ.loading;

  return (
    <div>
      <PageHeader title="Routing" description="How the gateway picks a provider and connection for each request." />

      {loading ? (
        <SkeletonTable rows={5} cols={2} />
      ) : configQ.error ? (
        <ErrorState message="Failed to load routing configuration." onRetry={configQ.refetch} />
      ) : config ? (
        <div className="grid gap-6">
          {/* ---- Routing Strategy ---- */}
          <Card className="p-5">
            <h2 className="text-base font-semibold text-foreground">Routing Strategy</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Changes apply to the next request — no gateway restart required. Invalid values are rejected.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <StrategySelect
                id="provider-strategy"
                label="Global Provider Routing"
                value={config.strategy}
                options={CORE_STRATEGIES.filter((s) => config.availableStrategies.includes(s))}
                disabled={saving !== null}
                onChange={(v) => applyScope('strategy', v)}
              />
              <StrategySelect
                id="connection-strategy"
                label="Connection Routing"
                value={config.connectionStrategy || 'priority'}
                options={CORE_STRATEGIES.filter((s) => (config.availableConnectionStrategies || []).includes(s))}
                disabled={saving !== null}
                onChange={(v) => applyScope('connectionStrategy', v)}
              />
              <StrategySelect
                id="key-strategy"
                label="API Key Routing"
                value={config.keySelectionStrategy || 'round-robin'}
                options={config.availableKeySelectionStrategies || []}
                disabled={saving !== null}
                onChange={(v) => applyScope('keySelectionStrategy', v)}
              />
            </div>
          </Card>

          {/* ---- Routing Status ---- */}
          {statusQ.data && (
            <Card className="p-5">
              <h2 className="text-base font-semibold text-foreground">Routing Status</h2>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                {[
                  ['Strategy', strategyLabel(statusQ.data.strategy)],
                  ['Providers', `${statusQ.data.activeProviders} active / ${statusQ.data.providers}`],
                  ['Connections', `${statusQ.data.activeConnections} active / ${statusQ.data.connections}`],
                  ['Disabled', String(statusQ.data.disabledConnections)],
                  ['Healthy', String(statusQ.data.healthyConnections)],
                  ['Unhealthy', String(statusQ.data.unhealthyConnections)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* ---- Model Routing Rules ---- */}
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground">Model Routing Rules</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Per-model overrides: bind a model to a strategy, provider order, and connection allow-list.
                </p>
              </div>
              <Button size="sm" onClick={openNewRule}>
                <Plus className="h-4 w-4" /> New Rule
              </Button>
            </div>
            {rulesQ.loading ? (
              <SkeletonTable rows={3} cols={4} />
            ) : (rulesQ.data || []).length === 0 ? (
              <EmptyState icon={Route} title="No routing rules" description="Create a rule to override routing for a specific model." />
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Model</th>
                      <th className="px-4 py-2 font-medium">Provider</th>
                      <th className="px-4 py-2 font-medium">Strategy</th>
                      <th className="px-4 py-2 font-medium">Connections</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(rulesQ.data || []).map((r) => (
                      <tr key={r.id} className="hover:bg-muted/40">
                        <td className="px-4 py-2 font-medium text-foreground">{r.model}</td>
                        <td className="px-4 py-2 text-muted-foreground">{(r.providerOrder || []).join(', ') || '—'}</td>
                        <td className="px-4 py-2 text-muted-foreground">{r.strategy ? strategyLabel(r.strategy) : '—'}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {r.connectionIds && r.connectionIds.length > 0 ? `${r.connectionIds.length} allowed` : 'all eligible'}
                        </td>
                        <td className="px-4 py-2">
                          <StatusBadge status={r.enabled !== false ? 'active' : 'disabled'} />
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Button variant="ghost" size="icon" aria-label="Edit rule" onClick={() => openEditRule(r)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" aria-label="Delete rule" onClick={() => removeRule(r)}>
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ---- Recent Routing Activity ---- */}
          <Card className="p-5">
            <h2 className="text-base font-semibold text-foreground">Recent Routing</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Live routing decisions. Credentials and API keys are never shown.
            </p>
            {activityQ.loading ? (
              <SkeletonTable rows={4} cols={6} />
            ) : (activityQ.data || []).length === 0 ? (
              <EmptyState icon={Route} title="No routing activity yet" description="Requests routed through the gateway will appear here." />
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Time</th>
                      <th className="px-4 py-2 font-medium">Model</th>
                      <th className="px-4 py-2 font-medium">Provider</th>
                      <th className="px-4 py-2 font-medium">Connection</th>
                      <th className="px-4 py-2 font-medium">Strategy</th>
                      <th className="px-4 py-2 font-medium">Latency</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(activityQ.data || []).map((e, i) => (
                      <tr key={i} className="hover:bg-muted/40">
                        <td className="px-4 py-2 text-muted-foreground">{formatRelative(e.timestamp)}</td>
                        <td className="px-4 py-2 font-medium text-foreground">{e.model || '—'}</td>
                        <td className="px-4 py-2 text-muted-foreground">{e.providerId || '—'}</td>
                        <td className="px-4 py-2 text-muted-foreground">{e.connectionName || e.connectionId || '—'}</td>
                        <td className="px-4 py-2 text-muted-foreground">{e.strategy || '—'}</td>
                        <td className="px-4 py-2 tabular-nums text-muted-foreground">{e.latencyMs}ms</td>
                        <td className="px-4 py-2">
                          <StatusBadge status={e.status >= 200 && e.status < 300 ? 'success' : 'error'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {/* ---- Rule editor modal ---- */}
      <Modal
        open={ruleModal}
        onClose={() => setRuleModal(false)}
        title={editingRule ? 'Edit Routing Rule' : 'New Routing Rule'}
        description="Bind a model to a routing strategy and optional provider/connection allow-list."
      >
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="rule-model">Model</Label>
            <Select id="rule-model" value={ruleModel} onChange={(e) => setRuleModel(e.target.value)}>
              <option value="">Select a model…</option>
              {(modelsQ.data || []).map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rule-provider">Provider</Label>
            <Select id="rule-provider" value={ruleProvider} onChange={(e) => { setRuleProvider(e.target.value); setRuleConnections([]); }}>
              <option value="">Any provider</option>
              {(providersQ.data || []).map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rule-strategy">Strategy</Label>
            <Select id="rule-strategy" value={ruleStrategy} onChange={(e) => setRuleStrategy(e.target.value)}>
              {CORE_STRATEGIES.map((s) => (
                <option key={s} value={s}>{strategyLabel(s)}</option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">{descriptions[ruleStrategy] || ''}</p>
          </div>
          {ruleProvider && providerConnections.length > 0 && (
            <div className="grid gap-1.5">
              <Label>Connections</Label>
              <div className="grid gap-1">
                {providerConnections.map((c) => {
                  const id = c.accountId || c.id || '';
                  const checked = ruleConnections.includes(id);
                  const disabled = c.enabled === false;
                  return (
                    <label key={id} className="flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={(e) => {
                          setRuleConnections((prev) =>
                            e.target.checked ? [...prev, id] : prev.filter((x) => x !== id));
                        }}
                      />
                      <span>{c.displayName || c.name || id}</span>
                      {disabled && <span className="text-xs text-muted-foreground">(disabled)</span>}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Unchecked connections are never selected for this model. Disabled connections are always excluded.
              </p>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setRuleModal(false)} disabled={ruleSaving}>
              Cancel
            </Button>
            <Button onClick={saveRule} disabled={ruleSaving}>
              {ruleSaving ? 'Saving…' : 'Save Rule'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
