import { Ban, Check, CircleAlert, Loader2, Minus, TriangleAlert, type LucideIcon } from 'lucide-react'
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

export function ResultBadge({ result }: { result: Result }) {
  const { label, icon: Icon, badge } = RESULT[result]
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
