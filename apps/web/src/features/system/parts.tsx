import { CircleAlert, CircleCheck, CircleMinus, CircleX, type LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Day, Status } from './api.ts'

/** The pieces the status page draws components and machines with alike. */

/**
 * A status's word, icon and tone — the meaning colours, each with an icon and
 * a word so colour never carries it alone. Red only for down: that is the one
 * that wants someone now.
 */
export const STATUS: Record<Status, { label: string; icon: LucideIcon; text: string; bar: string }> = {
  ok: { label: 'Operational', icon: CircleCheck, text: 'text-success', bar: 'bg-success' },
  degraded: { label: 'Degraded', icon: CircleAlert, text: 'text-warning', bar: 'bg-warning' },
  down: { label: 'Down', icon: CircleX, text: 'text-destructive', bar: 'bg-destructive' },
  off: { label: 'Not configured', icon: CircleMinus, text: 'text-muted-foreground', bar: 'bg-muted-foreground/25' },
}

/** Days drawn on a phone: the most recent; the rest need the width. */
const PHONE_DAYS = 30

/**
 * A bar per day, oldest on the left, each the worst the component was that
 * day — the way availability pages draw it. A 2px gap between bars, and a
 * tooltip on each with what the samples said. A phone shows the last 30 days.
 */
export function UptimeBar({ days, uptime, off }: { days: Day[]; uptime: number | null; off: boolean }) {
  return (
    <div>
      <ol className="flex h-8 items-stretch gap-[2px]" aria-label={`Daily status, the last ${days.length} days, oldest first`}>
        {days.map((d, i) => {
          const tone = d.worst === 'none' ? 'bg-muted' : STATUS[d.worst].bar
          const hideOnPhone = i < days.length - PHONE_DAYS ? 'hidden sm:block' : ''
          return (
            <li key={d.day} className={`min-w-0 flex-1 ${hideOnPhone}`}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`block h-full rounded-[2px] transition-opacity hover:opacity-75 ${tone}`}>
                    <span className="sr-only">
                      {formatDay(d.day)}: {dayText(d)}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <p className="font-medium">{formatDay(d.day)}</p>
                  <p>{dayText(d)}</p>
                </TooltipContent>
              </Tooltip>
            </li>
          )
        })}
      </ol>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="hidden sm:inline">{days.length} days ago</span>
        <span className="sm:hidden">{Math.min(days.length, PHONE_DAYS)} days ago</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="font-medium text-foreground tabular-nums">
          {off ? 'Not configured' : uptime === null ? 'No data yet' : `${formatUptime(uptime)} uptime`}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span>Today</span>
      </div>
    </div>
  )
}

function dayText(d: Day): string {
  if (d.worst === 'none') return 'No data recorded'
  if (d.worst === 'off') return 'Not configured'
  if (d.worst === 'ok') return `Operational — ${d.samples} checks`
  const parts = [d.down ? `${d.down} down` : '', d.degraded ? `${d.degraded} degraded` : ''].filter(Boolean)
  return `${parts.join(', ')} of ${d.samples} checks`
}

export const formatDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** 99.95%, not 99.94736%: availability is read to two places, and 100 only when it was. */
export function formatUptime(u: number): string {
  if (u >= 1) return '100%'
  return `${(Math.floor(u * 10_000) / 100).toFixed(2)}%`
}

