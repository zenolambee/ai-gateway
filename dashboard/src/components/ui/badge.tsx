import { cn } from '@/lib/utils';

type BadgeTone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

const TONES: Record<BadgeTone, string> = {
  success: 'bg-success/10 text-success ring-success/20',
  danger: 'bg-danger/10 text-danger ring-danger/20',
  warning: 'bg-warning/10 text-[hsl(32_81%_38%)] ring-warning/20',
  info: 'bg-primary/10 text-primary ring-primary/20',
  neutral: 'bg-muted text-muted-foreground ring-border',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

// Maps common status strings to a coloured badge. Never colour-only: always
// carries text so status is not communicated by colour alone.
export function StatusBadge({ status }: { status?: string }) {
  const s = (status || 'unknown').toLowerCase();
  let tone: BadgeTone = 'neutral';
  if (['active', 'healthy', 'online', 'connected', 'success', 'ok', 'ready', 'valid'].includes(s))
    tone = 'success';
  else if (['revoked', 'error', 'offline', 'failed', 'expired', 'invalid'].includes(s)) tone = 'danger';
  else if (['warning', 'degraded', 'inactive', 'disabled', 'pending'].includes(s)) tone = 'warning';
  else if (['info', 'unknown'].includes(s)) tone = 'neutral';
  return <Badge tone={tone}>{status || 'Unknown'}</Badge>;
}
