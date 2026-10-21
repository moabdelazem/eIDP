import type { ReactNode } from 'react'
import { cn } from 'cn'
import { m } from 'motion/react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimatedNumber } from './animated-number.tsx'

/**
 * A count in a tile: the request stats, Jenkins' "Failing now", My pipelines'
 * runs, the Overview's Jenkins card. A tile is a way in — a filter (`onClick`,
 * pressed while it is the one chosen) or a link (`to`) — so it is a button or
 * a link, never a bare div, and reachable by keyboard.
 *
 * The chosen tile carries a bar along its foot that slides to the next tile
 * chosen (one `layoutId` per row, `group`), so a change of filter shows where
 * it went. Red only when the count asks someone to act (`alarm`); the dot is
 * the status's own colour, always beside its word.
 */
export function StatTile({
  label,
  value,
  dot,
  alarm = false,
  selected,
  onClick,
  to,
  group,
  size = 'md',
}: {
  label: ReactNode
  /** Undefined while it loads. */
  value: number | string | undefined
  dot?: string | null
  alarm?: boolean
  /** A filter tile: whether it is the one chosen. */
  selected?: boolean
  onClick?: () => void
  to?: string
  /** Names the row, so the chosen-tile bar slides between its own tiles only. */
  group?: string
  size?: 'sm' | 'md'
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {dot && <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} />}
        <span className="truncate">{label}</span>
      </span>
      {value === undefined ? (
        <Skeleton className={cn('mt-1.5', size === 'sm' ? 'h-6 w-8' : 'h-7 w-10')} />
      ) : (
        <AnimatedNumber value={value} className={cn('mt-1 block font-semibold', size === 'sm' ? 'text-xl' : 'text-2xl', alarm && 'text-primary')} />
      )}
      {selected && group && <m.span layoutId={`stat-tile-${group}`} aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ring" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
    </>
  )
  const classes = cn(
    'relative block rounded-xl border bg-card px-4 py-3 text-left shadow-xs transition-[background-color,border-color,box-shadow] hover:border-ring/40 hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
    size === 'sm' && 'rounded-lg px-3 py-2 shadow-none',
    selected && 'border-ring/60 bg-secondary/40',
  )
  if (to) {
    return (
      <Link to={to} className={classes}>
        {body}
      </Link>
    )
  }
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={classes}>
      {body}
    </button>
  )
}
