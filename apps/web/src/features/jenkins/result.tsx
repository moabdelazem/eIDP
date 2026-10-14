import { Ban, Check, CircleAlert, History, Loader2, Minus, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { Result } from './api.ts'

/**
 * What a build's outcome looks like, from the same meaning colours requests
 * use. Red is a failure — something to act on. Unstable is amber: the build
 * ran and needs a look, but did not break. Every tone comes with an icon and
 * a word, so colour never carries it alone.
 */
export const RESULT: Record<Result, { label: string; icon: LucideIcon; badge: string; dot: string }> = {
  failure: { label: 'Failed', icon: TriangleAlert, badge: 'border-destructive/30 bg-destructive/5 text-destructive', dot: 'bg-destructive' },
  unstable: { label: 'Unstable', icon: CircleAlert, badge: 'border-warning/25 bg-warning-soft text-warning', dot: 'bg-warning' },
  running: { label: 'Running', icon: Loader2, badge: 'border-info/25 bg-info-soft text-info', dot: 'bg-info' },
  success: { label: 'Passed', icon: Check, badge: 'border-success/25 bg-success-soft text-success', dot: 'bg-success' },
  aborted: { label: 'Aborted', icon: Ban, badge: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
  not_built: { label: 'Not built', icon: Minus, badge: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
}

/**
 * A result's look, safe for any value the API sends. A result this build does
 * not know (Jenkins or a newer API added one) is shown by its own name in a
 * neutral style — never undefined, which would take the page down.
 */
export function resultOf(result: string): (typeof RESULT)[Result] {
  return RESULT[result as Result] ?? { ...RESULT.not_built, label: result ? result.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()) : 'Unknown' }
}

export function ResultBadge({ result }: { result: Result }) {
  const { label, icon: Icon, badge } = resultOf(result)
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge}`}>
      <Icon className={`size-3.5 ${result === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      {label}
    </span>
  )
}

/**
 * A job's full name with its folders quiet and its own name clear, wrapping
 * only between segments — the same rule as request paths.
 */
export function JobName({ name, className = '' }: { name: string; className?: string }) {
  const parts = name.split('/').map(decodeName)
  return (
    <code className={`break-words ${className}`}>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && (
            <span className="text-muted-foreground">
              /<wbr />
            </span>
          )}
          <span className={index === parts.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}>{part}</span>
        </span>
      ))}
    </code>
  )
}

/** A multibranch job names branch feature/x as "feature%2Fx"; people know it by the slash. */
function decodeName(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** "You opened this last", on the row someone comes back to — a word and an icon, and no meaning colour. */
export function OpenedLast() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-[11px] font-normal text-secondary-foreground">
      <History className="size-3" aria-hidden />
      Opened last
    </span>
  )
}
