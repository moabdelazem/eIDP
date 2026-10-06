import { useState } from 'react'

/** How someone likes to read logs, kept per browser — a convenience, so it degrades to the defaults when storage is not there. */
export type LogPrefs = { wrap: boolean; hideSteps: boolean; times: boolean; size: 'sm' | 'md' | 'lg' }

const KEY = 'eidp.log'
const DEFAULTS: LogPrefs = { wrap: true, hideSteps: true, times: true, size: 'md' }

/** Text and row height per size; the row height is what `content-visibility` assumes for lines not drawn yet. */
export const SIZES = {
  sm: { text: 'text-[11px] leading-[18px]', row: 18 },
  md: { text: 'text-xs leading-5', row: 20 },
  lg: { text: 'text-[13px] leading-6', row: 24 },
} as const

function read(): LogPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LogPrefs>
    return { ...DEFAULTS, ...stored, size: stored.size && stored.size in SIZES ? stored.size : DEFAULTS.size }
  } catch {
    return DEFAULTS
  }
}

export function useLogPrefs(): [LogPrefs, <K extends keyof LogPrefs>(key: K, value: LogPrefs[K]) => void] {
  const [prefs, setPrefs] = useState(read)
  const set = <K extends keyof LogPrefs>(key: K, value: LogPrefs[K]) =>
    setPrefs((p) => {
      const next = { ...p, [key]: value }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // A private window or blocked storage: it holds for this visit.
      }
      return next
    })
  return [prefs, set]
}
