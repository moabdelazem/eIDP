import { Fragment } from 'react'
import { cn } from 'cn'
import { envLabel, inOrder, isProduction } from './tree.ts'

/**
 * The small pieces the map's canvas, its list and its panel share, so an
 * environment or a technology reads the same in all three.
 */

/**
 * Where an application runs, in pipeline order. Production carries a filled
 * eggplant dot and a heavier border — marked, never red, because running in
 * production is a fact, not something to act on.
 */
export function EnvPills({ environments, className, size = 'sm' }: { environments: string[]; className?: string; size?: 'xs' | 'sm' }) {
  if (environments.length === 0) return <span className={cn('text-xs text-muted-foreground', className)}>No environments yet</span>
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {inOrder(environments).map((env) => {
        const prod = isProduction(env)
        return (
          <span
            key={env}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border font-medium tabular-nums',
              size === 'xs' ? 'px-1.5 py-px text-[10px]' : 'px-2 py-0.5 text-[11px]',
              prod ? 'border-[var(--chart-1)]/50 text-foreground' : 'text-muted-foreground',
            )}
          >
            {prod && <span aria-hidden className="size-1.5 rounded-full bg-[var(--chart-1)]" />}
            {envLabel(env)}
            {prod && <span className="sr-only"> (production)</span>}
          </span>
        )
      })}
    </span>
  )
}

/** How an application is built, as a quiet tag. */
export function TechTag({ technology, className }: { technology: string | null | undefined; className?: string }) {
  if (!technology) return null
  return <span className={cn('inline-flex items-center rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground', className)}>{technology}</span>
}

/** A label with the part that matched the search marked, so a result shows why it is there. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), hit: false })
    parts.push({ text: text.slice(i, i + needle.length), hit: true })
    at = i + needle.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-sm bg-[var(--chart-1)]/15 px-px text-inherit">
            {part.text}
          </mark>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}
