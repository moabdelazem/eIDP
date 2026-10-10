import { CircleCheck, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { STAGE, type Kind, type Line } from './parse.ts'

const TONE: Record<Kind, string> = {
  error: 'bg-destructive/[0.06] text-foreground border-l-destructive',
  warning: 'bg-warning-soft/70 text-foreground border-l-warning',
  // Pinned while its lines scroll under it; opaque, or they would show through.
  stage: 'sticky top-0 z-[1] mt-2 bg-card py-1 text-foreground font-semibold border-l-[var(--chart-1)] shadow-[0_1px_0_var(--border)]',
  step: 'text-muted-foreground/70 border-l-transparent',
  command: 'text-foreground border-l-transparent',
  done: 'text-success font-semibold border-l-success',
  plain: 'text-foreground/90 border-l-transparent',
}

// A pinned heading scrolls over lines, so its selected fill is mixed opaque, never translucent.
const SELECTED_HEADING = 'bg-[color-mix(in_oklab,var(--secondary)_70%,var(--card))]!'

export function LogLine({
  line,
  wrap,
  needle,
  active,
  selected,
  timed,
  fresh,
  rowHeight,
  onSelect,
}: {
  line: Line
  wrap: boolean
  needle: string
  active: boolean
  selected: boolean
  timed: boolean
  fresh: boolean
  rowHeight: number
  onSelect: (n: number, extend: boolean) => void
}) {
  const text = line.kind === 'stage' ? STAGE.exec(line.text)![1]! : line.kind === 'command' ? line.text.slice(2) : line.text
  return (
    <div
      data-line={line.n}
      className={`flex border-l-2 hover:bg-muted/50 ${TONE[line.kind]} ${selected ? (line.kind === 'stage' ? SELECTED_HEADING : 'bg-secondary/70!') : ''} ${active ? 'bg-secondary!' : ''} ${fresh ? 'reveal' : ''}`}
      // A pinned heading must always be drawn: content-visibility would skip it once its own spot scrolled away.
      style={line.kind === 'stage' ? undefined : { contentVisibility: 'auto', containIntrinsicSize: `auto ${rowHeight}px` }}
    >
      <span
        className="w-14 shrink-0 cursor-pointer pr-3 text-right font-normal text-muted-foreground/60 tabular-nums select-none hover:text-foreground hover:underline"
        onClick={(e) => onSelect(line.n, e.shiftKey)}
        title="Select this line (shift: a range)"
        aria-hidden
      >
        {line.n}
      </span>
      <span className="w-4 shrink-0 select-none" aria-hidden>
        {line.kind === 'error' ? (
          <TriangleAlert className="mt-0.5 size-3 text-destructive" />
        ) : line.kind === 'warning' ? (
          <TriangleAlert className="mt-0.5 size-3 text-warning" />
        ) : line.kind === 'done' ? (
          <CircleCheck className="mt-0.5 size-3" />
        ) : null}
      </span>
      {timed && <span className="hidden w-[4.75rem] shrink-0 font-normal text-muted-foreground/70 tabular-nums select-none sm:block">{line.time}</span>}
      {line.kind === 'error' && <span className="sr-only">Error: </span>}
      {line.kind === 'warning' && <span className="sr-only">Warning: </span>}
      {line.kind === 'stage' && <span className="font-normal text-muted-foreground select-none">Stage&nbsp;</span>}
      {line.kind === 'command' && (
        <span className="text-[var(--chart-1)] select-none" aria-label="Command:">
          $&nbsp;
        </span>
      )}
      <span className={`min-w-0 pr-4 ${wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'}`}>{render(text, needle)}</span>
    </div>
  )
}

// http(s) only, and without the punctuation a sentence puts after a URL.
const URL_RE = /https?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]]/g

/** The text with its URLs as links (new tab) and every occurrence of the find term marked. */
function render(text: string, needle: string): ReactNode {
  if (!text) return ' '
  const out: ReactNode[] = []
  let from = 0
  for (const m of text.matchAll(URL_RE)) {
    // A URL carrying credentials stays text: a link would only make them easier to follow somewhere.
    if (/^https?:\/\/[^/]*@/.test(m[0])) continue
    out.push(...marked(text.slice(from, m.index), needle, from))
    out.push(
      <a key={`u${m.index}`} href={m[0]} target="_blank" rel="noreferrer noopener" className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground">
        {marked(m[0], needle, m.index)}
      </a>,
    )
    from = m.index + m[0].length
  }
  out.push(...marked(text.slice(from), needle, from))
  return out
}

function marked(text: string, needle: string, offset: number): ReactNode[] {
  if (!needle) return [text]
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    parts.push(
      text.slice(from, at),
      <mark key={`m${offset + at}`} className="rounded-sm bg-warning-soft px-0.5 text-foreground ring-1 ring-warning/40">
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return parts
}
