import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

/** "+3", "−2", "0" — with a real minus sign. */
export function signed(n: number): string {
  return n > 0 ? `+${n.toLocaleString()}` : n < 0 ? `−${Math.abs(n).toLocaleString()}` : '0'
}

/**
 * A headline number with how it moved against the period before. The arrow
 * and sign say the direction; the colour says whether that is good — green,
 * or red when it wants a look. A neutral measure (how many builds) stays grey.
 */
export function Kpi({
  label,
  value,
  detail,
  delta,
  alarm = false,
  against = 'the window before',
}: {
  label: string
  value: string
  detail: string
  delta: { change: number; text: string; good: 'up' | 'down' | null } | null
  alarm?: boolean
  /** What the delta compares with, for screen readers. */
  against?: string
}) {
  let tone = 'text-muted-foreground'
  if (delta && delta.change !== 0 && delta.good) {
    const better = delta.good === 'up' ? delta.change > 0 : delta.change < 0
    tone = better ? 'text-success' : 'text-destructive'
  }
  const Icon = !delta || delta.change === 0 ? Minus : delta.change > 0 ? ArrowUpRight : ArrowDownRight
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${alarm ? 'text-primary' : ''}`}>{value}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {delta && (
          <span className={`inline-flex items-center gap-0.5 font-medium ${tone}`}>
            <Icon className="size-3.5" aria-hidden />
            {delta.text}
            <span className="sr-only"> against {against}</span>
          </span>
        )}
        <span>{detail}</span>
      </p>
    </div>
  )
}
