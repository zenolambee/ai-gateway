'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Progress bar with a colour band derived from percentage. Backend remains the
 * source of truth for the values; this only renders them. Never colour-only —
 * the numeric percentage is always shown alongside by callers.
 */
export function ProgressBar({ percent, className }: { percent: number | null; className?: string }) {
  const p = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  let band = 'bg-success';
  if (p >= 90) band = 'bg-danger';
  else if (p >= 75) band = 'bg-warning';
  else if (p >= 50) band = 'bg-primary';
  return (
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
      aria-valuenow={Math.round(p)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cn('h-full rounded-full transition-all', band)} style={{ width: `${p}%` }} />
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}
