import { ChevronRight, CircleCheck, TriangleAlert } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { css } from './ansi.ts'
import type { TokenType } from './highlight.ts'
import type { Kind, Line } from './parse.ts'

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

/** A heading's folding: whether its lines are folded away, how many, and what is wrong in them. */
export type Fold = { folded: boolean; lines: number; errors: number; warnings: number; onToggle: () => void }

export function LogLine({
  line,
  wrap,
  needle,
  active,
  selected,
  timed,
  fresh,
  rowHeight,
  colours,
  highlighting,
  fold,
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
  /** Draw the log's own ANSI colours. */
  colours: boolean
  /** Highlight what no tool coloured. */
  highlighting: boolean
  /** Only on a stage heading. */
  fold?: Fold
  onSelect: (n: number, extend: boolean) => void
}) {
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
      <span className="w-4 shrink-0 select-none" aria-hidden={!fold}>
        {fold ? (
          <button
            type="button"
            onClick={fold.onToggle}
            className="mt-0.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-expanded={!fold.folded}
            aria-label={`${fold.folded ? 'Unfold' : 'Fold'} ${line.shown}`}
          >
            <ChevronRight className={`size-3.5 motion-safe:transition-transform ${fold.folded ? '' : 'rotate-90'}`} />
          </button>
        ) : line.kind === 'error' ? (
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
      {line.kind === 'stage' ? (
        <span className={`flex min-w-0 flex-wrap items-baseline gap-x-2 pr-4 ${wrap ? '' : 'whitespace-nowrap'}`}>
          <span className="min-w-0">
            <span className="font-normal text-muted-foreground select-none">Stage&nbsp;</span>
            {/* The stages around it, so a pinned heading says where in the pipeline you are. */}
            {line.path!.slice(0, -1).map((name) => (
              <span key={name} className="font-normal text-muted-foreground">
                {name}
                <span aria-hidden> › </span>
              </span>
            ))}
            {render(line, needle, false, false)}
          </span>
          {fold && (fold.errors > 0 || fold.warnings > 0 || fold.folded) && (
            <span className="flex items-center gap-2 text-[11px] font-normal text-muted-foreground tabular-nums select-none">
              {fold.errors > 0 && (
                <span className="flex items-center gap-0.5 text-destructive">
                  <TriangleAlert className="size-3" aria-hidden /> {fold.errors} {fold.errors === 1 ? 'error' : 'errors'}
                </span>
              )}
              {fold.warnings > 0 && (
                <span className="flex items-center gap-0.5 text-warning">
                  <TriangleAlert className="size-3" aria-hidden /> {fold.warnings} {fold.warnings === 1 ? 'warning' : 'warnings'}
                </span>
              )}
              {fold.folded && (
                <button type="button" onClick={fold.onToggle} className="hover:text-foreground hover:underline">
                  {fold.lines} {fold.lines === 1 ? 'line' : 'lines'} folded
                </button>
              )}
            </span>
          )}
        </span>
      ) : (
        <>
          {line.kind === 'command' && (
            <span className="text-[var(--chart-1)] select-none" aria-label="Command:">
              $&nbsp;
            </span>
          )}
          <span className={`min-w-0 pr-4 ${wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'}`}>{render(line, needle, colours, highlighting)}</span>
        </>
      )}
    </div>
  )
}

// http(s) only, and without the punctuation a sentence puts after a URL.
const URL_RE = /https?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]]/g

/** How each highlighted kind of text reads: the DataView palette, and the meaning colours only for meanings. */
const TOKEN_CLASS: Record<TokenType, string> = {
  program: 'font-semibold text-[var(--shiki-token-keyword)]',
  flag: 'text-[var(--shiki-token-constant)]',
  variable: 'text-[var(--shiki-token-function)]',
  operator: 'text-[var(--shiki-token-punctuation)]',
  string: 'text-[var(--shiki-token-string)]',
  number: 'text-[var(--shiki-token-constant)]',
  constant: 'text-[var(--shiki-token-constant)]',
  key: 'text-[var(--shiki-token-keyword)]',
  path: 'text-[var(--shiki-token-string)]',
  url: '',
  muted: 'text-muted-foreground',
  function: 'font-medium text-[var(--shiki-token-keyword)]',
  error: 'font-semibold text-destructive',
  warning: 'font-semibold text-warning',
  info: 'text-info',
  success: 'font-semibold text-success',
}

type Run = { start: number; end: number; style?: CSSProperties; className?: string }

/**
 * The shown text in pieces: its colour runs (the tool's ANSI colours, else
 * the highlighter's), its links, and the find term marked. Each layer is laid
 * over the whole line, so a match that crosses two colours is still one mark.
 */
function render(line: Line, needle: string, colours: boolean, highlighting: boolean): ReactNode {
  const text = line.shown
  if (!text) return ' '

  const runs: Run[] = []
  if (colours && line.segments) {
    let at = 0
    for (const s of line.segments) {
      runs.push({ start: at, end: at + s.text.length, style: css(s.style) })
      at += s.text.length
    }
  } else if (highlighting && line.tokens.length) {
    let at = 0
    for (const t of line.tokens) {
      if (t.start > at) runs.push({ start: at, end: t.start })
      runs.push({ start: t.start, end: t.end, className: TOKEN_CLASS[t.type] })
      at = t.end
    }
    if (at < text.length) runs.push({ start: at, end: text.length })
  } else runs.push({ start: 0, end: text.length })

  // A URL carrying credentials stays text: a link would only make them easier to follow somewhere.
  const links = [...text.matchAll(URL_RE)].filter((m) => !/^https?:\/\/[^/]*@/.test(m[0])).map((m) => ({ start: m.index, end: m.index + m[0].length, href: m[0] }))
  const marks: { start: number; end: number }[] = []
  if (needle) {
    const lower = text.toLowerCase()
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) marks.push({ start: at, end: at + needle.length })
  }

  const cuts = new Set<number>([0, text.length])
  for (const r of [...runs, ...links, ...marks]) cuts.add(r.start).add(r.end)
  const points = [...cuts].sort((a, b) => a - b)
  const inside = <T extends { start: number; end: number }>(list: T[], at: number) => list.find((r) => at >= r.start && at < r.end)

  const out: ReactNode[] = []
  // The link being drawn, a piece at a time: an object, so the closures below see it change.
  const open: { link: { href: string; start: number; parts: ReactNode[] } | null } = { link: null }
  const closeLink = () => {
    const link = open.link
    if (!link) return
    out.push(
      <a key={`u${link.start}`} href={link.href} target="_blank" rel="noreferrer noopener" className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground">
        {link.parts}
      </a>,
    )
    open.link = null
  }
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!
    const end = points[i + 1]!
    if (end <= start) continue
    const run = inside(runs, start)
    const piece = text.slice(start, end)
    const drawn = inside(marks, start) ? (
      <mark key={`m${start}`} style={run?.style} className={`rounded-sm bg-warning-soft px-0.5 text-foreground ring-1 ring-warning/40 ${run?.className ?? ''}`}>
        {piece}
      </mark>
    ) : run?.style || run?.className ? (
      <span key={`s${start}`} style={run.style} className={run.className}>
        {piece}
      </span>
    ) : (
      piece
    )
    const href = inside(links, start)
    if (href && open.link?.href !== href.href) {
      closeLink()
      open.link = { href: href.href, start, parts: [] }
    } else if (!href) closeLink()
    if (open.link) open.link.parts.push(drawn)
    else out.push(drawn)
  }
  closeLink()
  return out
}
