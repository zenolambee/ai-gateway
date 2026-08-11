'use client';

import { Input, Label, FieldError, Select } from '@/components/ui/input';
import type { ResetPeriod } from '@/lib/types';

export interface QuotaFormValue {
  tokenLimit: string;
  resetPeriod: ResetPeriod;
  rateLimit: string;
  expiration: 'never' | 'custom';
  expiresAtDate: string;
}

export const emptyQuota: QuotaFormValue = {
  tokenLimit: '',
  resetPeriod: 'monthly',
  rateLimit: '',
  expiration: 'never',
  expiresAtDate: '',
};

export interface QuotaFormErrors {
  tokenLimit?: string;
  rateLimit?: string;
  expiresAtDate?: string;
}

export function validateQuota(v: QuotaFormValue): QuotaFormErrors {
  const errors: QuotaFormErrors = {};
  if (v.tokenLimit) {
    const n = Number(v.tokenLimit);
    if (!Number.isFinite(n) || n < 0) errors.tokenLimit = 'Token limit must be zero or a positive number.';
  }
  if (v.rateLimit) {
    const n = Number(v.rateLimit);
    if (!Number.isFinite(n) || n < 0) errors.rateLimit = 'Rate limit must be zero or a positive number.';
  }
  if (v.expiration === 'custom') {
    if (!v.expiresAtDate) errors.expiresAtDate = 'Choose an expiration date.';
    else if (Number.isNaN(Date.parse(v.expiresAtDate))) errors.expiresAtDate = 'Invalid date.';
    else if (Date.parse(v.expiresAtDate) <= Date.now()) errors.expiresAtDate = 'Expiration must be in the future.';
  }
  return errors;
}

export function QuotaForm({
  value,
  errors,
  onChange,
}: {
  value: QuotaFormValue;
  errors: QuotaFormErrors;
  onChange: (v: QuotaFormValue) => void;
}) {
  const set = <K extends keyof QuotaFormValue>(k: K, val: QuotaFormValue[K]) => onChange({ ...value, [k]: val });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tokenLimit">Token Quota</Label>
          <Input
            id="tokenLimit"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="e.g. 1000000 (empty = unlimited)"
            value={value.tokenLimit}
            onChange={(e) => set('tokenLimit', e.target.value)}
            aria-invalid={!!errors.tokenLimit}
          />
          <FieldError>{errors.tokenLimit}</FieldError>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="resetPeriod">Reset Period</Label>
          <Select
            id="resetPeriod"
            value={value.resetPeriod}
            onChange={(e) => set('resetPeriod', e.target.value as ResetPeriod)}
          >
            <option value="never">Never</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rateLimit">Rate Limit (requests / minute)</Label>
        <Input
          id="rateLimit"
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="e.g. 100 (empty = no limit)"
          value={value.rateLimit}
          onChange={(e) => set('rateLimit', e.target.value)}
          aria-invalid={!!errors.rateLimit}
        />
        <FieldError>{errors.rateLimit}</FieldError>
      </div>

      <div className="space-y-2">
        <Label>Expiration</Label>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="expiration"
              checked={value.expiration === 'never'}
              onChange={() => set('expiration', 'never')}
              className="h-4 w-4 accent-[hsl(221_83%_53%)]"
            />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="expiration"
              checked={value.expiration === 'custom'}
              onChange={() => set('expiration', 'custom')}
              className="h-4 w-4 accent-[hsl(221_83%_53%)]"
            />
            Custom date
          </label>
        </div>
        {value.expiration === 'custom' && (
          <div className="space-y-1.5">
            <Input
              type="datetime-local"
              value={value.expiresAtDate}
              onChange={(e) => set('expiresAtDate', e.target.value)}
              aria-invalid={!!errors.expiresAtDate}
              aria-label="Expiration date"
            />
            <FieldError>{errors.expiresAtDate}</FieldError>
          </div>
        )}
      </div>
    </div>
  );
}
