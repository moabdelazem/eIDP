import { Skeleton } from '@/components/ui/skeleton'

/**
 * Loading placeholders shaped like what replaces them, so the page does not
 * jump when the data lands and the reader already sees where things will be.
 * Each mirrors the spacing of its real counterpart — change one, change both.
 *
 * Screen readers get one "Loading…" per region rather than a run of empty divs.
 */
export function Loading({ label = 'Loading…', className, children }: { label?: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div aria-hidden className={className}>
        {children}
      </div>
    </div>
  )
}

/** The page's h1 and the line beneath it. */
export function HeaderSkeleton({ lead = true }: { lead?: boolean }) {
  return (
    <>
      <Skeleton className="h-6 w-56" />
      {lead && <Skeleton className="mt-2.5 h-4 w-80 max-w-full" />}
    </>
  )
}

/** A label/value list, like an application's facts or a profile. */
export function FactsSkeleton({ rows = 4, className = 'mt-8' }: { rows?: number; className?: string }) {
  return (
    <div className={`grid grid-cols-[8rem_minmax(0,1fr)] gap-y-4 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="contents">
          <Skeleton className="h-4 w-20" />
          {/* Varied widths, so it reads as text rather than a table of bars. */}
          <Skeleton className="h-4" style={{ width: `${[55, 35, 45, 25, 40, 30][i % 6]}%` }} />
        </div>
      ))}
    </div>
  )
}

/** Rows shaped like `RequestRow`: icon, name over its context, status on the right. */
export function RowsSkeleton({ rows = 3, bordered = true }: { rows?: number; bordered?: boolean }) {
  return (
    <ul className={`divide-y ${bordered ? 'rounded-lg border bg-card' : 'border-t'}`}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4" style={{ width: `${[40, 55, 30][i % 3]}%` }} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <div className="hidden flex-col items-end gap-2 sm:flex">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-3 w-14" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** A card holding a request waiting on a decision. */
export function CardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-start gap-3">
        <Skeleton className="mt-1 size-4 shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/4" />
        </div>
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="mt-4 h-3 w-3/4" />
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-20" />
      </div>
    </div>
  )
}

/** A request's timeline: a dot and a line per step. */
export function TimelineSkeleton({ steps = 3 }: { steps?: number }) {
  return (
    <div className="space-y-8">
      {Array.from({ length: steps }, (_, i) => (
        <div key={i} className="flex gap-4">
          <Skeleton className="mt-1 size-[15px] shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4" style={{ width: `${[45, 35, 40][i % 3]}%` }} />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A ranked horizontal bar chart: a name, then a bar that shortens down the list. */
export function BarsSkeleton({ bars = 8 }: { bars?: number }) {
  return (
    <Loading label="Loading chart…" className="flex h-64 flex-col justify-center gap-3">
      {Array.from({ length: bars }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="h-3.5" style={{ width: `${70 - i * 7}%` }} />
        </div>
      ))}
    </Loading>
  )
}
