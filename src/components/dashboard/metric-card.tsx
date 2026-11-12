import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

/**
 * Accent stripe on the card's left edge + matching icon tint. Class
 * strings are spelled out in full so Tailwind's scanner picks them up.
 */
const ACCENTS = {
  primary: { stripe: 'border-l-primary', icon: 'bg-primary/10 text-primary' },
  sky: { stripe: 'border-l-sky-500', icon: 'bg-sky-500/10 text-sky-800 dark:text-sky-300' },
  emerald: { stripe: 'border-l-emerald-500', icon: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' },
  amber: { stripe: 'border-l-amber-500', icon: 'bg-amber-500/10 text-amber-800 dark:text-amber-300' },
  violet: { stripe: 'border-l-violet-500', icon: 'bg-violet-500/10 text-violet-800 dark:text-violet-300' },
  teal: { stripe: 'border-l-teal-500', icon: 'bg-teal-500/10 text-teal-800 dark:text-teal-300' },
  rose: { stripe: 'border-l-rose-500', icon: 'bg-rose-500/10 text-rose-800 dark:text-rose-300' },
} as const

export type MetricAccent = keyof typeof ACCENTS

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
  accent?: MetricAccent
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle, accent }: MetricCardProps) {
  const tone = accent ? ACCENTS[accent] : null
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl border border-border bg-card p-5',
        tone && ['border-l-[3px]', tone.stripe],
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            tone ? tone.icon : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 break-words font-serif text-3xl leading-tight tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-primary'
      : sign < 0
      ? 'text-destructive'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-2 flex items-center gap-1 text-sm', tone)}>
      <Arrow className="h-4 w-4" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
