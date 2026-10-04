import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, CircleCheck, ChevronDown, ChevronUp, Copy, ExternalLink, Search, TriangleAlert, WrapText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/ui/toggle'

type Kind = 'error' | 'warning' | 'stage' | 'step' | 'command' | 'done' | 'plain'
/** `time` is the `timestamps {}` prefix, shown in its own column and taken off the text. */
type Line = { n: number; text: string; kind: Kind; stage: string | null; time: string | null }

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const STAGE = /^\[Pipeline\] \{ \((.+)\)$/
// Case-sensitive on purpose: "ERROR" is a log level, "error" is often prose
// ("0 errors"). Counts only count when they are not zero.
const ERROR = /(^|[\s[])(ERROR|FATAL|SEVERE)\b|\bBUILD FAILURE\b|Finished: FAILURE|\b(Failures|Errors): [1-9]|exit code [1-9]|Exception\b|^\s+at [\w$.]+\(/
const WARNING = /(^|[\s[])(WARN|WARNING)\b|Finished: UNSTABLE/
// Pipeline's `timestamps {}` writes `[2026-10-04T09:12:03.120Z] ` before each line; older setups `[09:12:03] `.
const TIME = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|\d{2}:\d{2}:\d{2})\] ?/
const clock = (stamp: string) =>
  stamp.includes('T') ? new Date(stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : stamp

/** Reads a log once into lines that know what they are and which stage they belong to. */
function parse(log: string, firstLine: number): Line[] {
  let stage: string | null = null
  return log
    .replace(ANSI, '')
    .replace(/\n$/, '')
    .split('\n')
    .map((raw, i) => {
      const stamp = TIME.exec(raw)
      const text = stamp ? raw.slice(stamp[0].length) : raw
      const opening = STAGE.exec(text)
      if (opening) stage = opening[1]!
      const kind: Kind = opening
        ? 'stage'
        : ERROR.test(text)
          ? 'error'
          : WARNING.test(text)
            ? 'warning'
            : text.startsWith('[Pipeline]')
              ? 'step'
              : text.startsWith('+ ')
                ? 'command'
                : text === 'Finished: SUCCESS'
                  ? 'done'
                  : 'plain'
      return { n: firstLine + i, text, kind, stage, time: stamp ? clock(stamp[1]!) : null }
    })
}

/**
 * A build's console log, made readable: numbered lines, errors and warnings
 * marked (with an icon, not colour alone), pipeline stages as headings, find
 * with next/previous, jump between errors, and filters for the two things
 * people do with a failed log — read the errors with their context, and read
 * it without Jenkins' own `[Pipeline]` bookkeeping.
 *
 * Opens at the first error when there is one, else at the end. Stage
 * headings stay pinned at the top of the box while their lines scroll under
 * them; shell commands read as commands, and timestamps sit in a column of
 * their own rather than in front of every line.
 *
 * While the build runs (`live`) it is a tail: it opens at the end and keeps
 * to it as lines arrive, new lines fading in. Scrolling up pauses that —
 * nobody wants the line they are reading pulled away — and "Jump to latest"
 * (or scrolling back down) takes it up again. When the build ends it stays
 * where it was, at the end if it was following.
 */
export function LogViewer({
  log,
  truncated,
  fullUrl,
  jump,
  live = false,
}: {
  log: string
  truncated: boolean
  fullUrl: string
  /** The build is still running and the log still growing. */
  live?: boolean
  /** A line to show from outside — the explanation's evidence. `at` makes the same line jumpable twice. */
  jump?: { line: number; at: number } | null
}) {
  // A cut log starts mid-way; its numbers are relative to what is shown.
  const lines = useMemo(() => parse(log, 1), [log])
  const errors = useMemo(() => lines.filter((l) => l.kind === 'error').map((l) => l.n), [lines])

  const [wrap, setWrap] = useState(true)
  const [hideSteps, setHideSteps] = useState(true)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [find, setFind] = useState('')
  const [current, setCurrent] = useState(0)
  // Opens at the first error, where a failed build explains itself — unless it is still running, when the end is the news.
  const [focusLine, setFocusLine] = useState<number | null>(() => (live ? null : (errors[0] ?? null)))
  const box = useRef<HTMLDivElement>(null)

  // Following the end of a running log; the last line seen when it paused, to count what came since.
  const [follow, setFollow] = useState(live)
  const last = lines.at(-1)?.n ?? 0
  const [pausedAt, setPausedAt] = useState(last)
  // Lines that arrived in the latest update fade in; everything there on first sight does not.
  const [seen, setSeen] = useState({ upTo: last, prev: last })
  if (seen.prev !== last) setSeen({ upTo: seen.prev, prev: last })

  const needle = find.trim().toLowerCase()
  const matches = useMemo(() => (needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)).map((l) => l.n) : []), [lines, needle])
  // A new term starts from its first match.
  // A jump from outside wins over find, and brings the log into view.
  const [shownJump, setShownJump] = useState(jump)
  if (jump && jump !== shownJump) {
    setShownJump(jump)
    setFind('')
    setFocusLine(jump.line)
  }
  const outer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!jump || !outer.current) return
    // The window, not scrollIntoView: that scrolls every ancestor, and shifted the sidebar rail.
    window.scrollTo({ top: outer.current.getBoundingClientRect().top + window.scrollY - 72 })
  }, [jump])

  const [shownNeedle, setShownNeedle] = useState(needle)
  if (needle !== shownNeedle) {
    setShownNeedle(needle)
    setCurrent(0)
  }

  // Errors with two lines either side — enough to see what led to each.
  const nearError = useMemo(() => {
    const keep = new Set<number>()
    for (const n of errors) for (let k = n - 2; k <= n + 2; k++) keep.add(k)
    return keep
  }, [errors])

  // Find wins over the filters: a match is always shown, or "3 of 40" would
  // step through lines nobody can see.
  const matched = new Set(matches)
  const visible = lines.filter(
    (l) =>
      matched.has(l.n) ||
      l.n === focusLine ||
      ((!hideSteps || l.kind !== 'step') && (!errorsOnly || nearError.has(l.n) || l.kind === 'stage')),
  )

  // Where to look: the find result being stepped through, else a jumped-to line.
  const target = needle && matches.length ? matches[current % matches.length]! : focusLine
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${target}"]`)
    // Scrolled within the log only: scrollIntoView would scroll the page too,
    // and on a long page that shifts the sidebar rail out from under you.
    if (target === null || !el || !box.current) return
    box.current.scrollTop = el.offsetTop - box.current.clientHeight / 2
  }, [target, errorsOnly, hideSteps, jump])

  // With no error to open at, open at the end, where the build finished (or is now).
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !box.current) return
    opened.current = true
    if (errors.length === 0 || live) box.current.scrollTop = box.current.scrollHeight
  }, [errors, live])

  // Following: every update lands at the end, before it is painted. The last
  // one — the build finishing — lands there too, and then following stops.
  useLayoutEffect(() => {
    if (!follow || !box.current) return
    box.current.scrollTop = box.current.scrollHeight
    if (!live) setFollow(false)
  }, [follow, live, lines, hideSteps, errorsOnly, wrap])

  // Lines below the fold take their real (wrapped) height only once drawn, so
  // the end moves after the jump to it: while following, stay pinned to it.
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(follow)
  following.current = follow
  useEffect(() => {
    if (!content.current || !box.current) return
    const pin = new ResizeObserver(() => {
      if (following.current && box.current) box.current.scrollTop = box.current.scrollHeight
    })
    pin.observe(content.current)
    return () => pin.disconnect()
  }, [])

  // Scrolling decides following: away from the end pauses it, back to the end takes it up.
  const onScroll = () => {
    const el = box.current
    if (!live || !el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    if (atEnd === follow) return
    setFollow(atEnd)
    if (!atEnd) setPausedAt(last)
  }
  const resume = () => {
    setFind('')
    setFocusLine(null)
    setFollow(true)
  }
  const unseen = truncated ? 0 : Math.max(0, last - pausedAt)
  const runningStage = lines.findLast((l) => l.kind === 'stage')?.stage ?? null
  const timed = lines.some((l) => l.time)

  const step = (by: number) => setCurrent((c) => (c + by + matches.length) % Math.max(matches.length, 1))
  const nextError = (by: number) => {
    if (errors.length === 0) return
    const from = focusLine ?? 0
    const next = by > 0 ? (errors.find((n) => n > from) ?? errors[0]!) : ([...errors].reverse().find((n) => n < from) ?? errors.at(-1)!)
    setFind('')
    setFocusLine(next)
  }

  return (
    <div ref={outer} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              }
            }}
            placeholder="Find in log"
            aria-label="Find in log"
            className="h-8 pr-20 pl-8 font-mono text-xs"
          />
          {needle && (
            <span className="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {matches.length ? `${(current % matches.length) + 1} of ${matches.length}` : 'None'}
            </span>
          )}
        </div>
        <Button size="icon" variant="ghost" className="size-8" onClick={() => step(-1)} disabled={!matches.length} aria-label="Previous match">
          <ChevronUp />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" onClick={() => step(1)} disabled={!matches.length} aria-label="Next match">
          <ChevronDown />
        </Button>

        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />

        <Button size="sm" variant="outline" className="h-8" onClick={() => nextError(1)} disabled={errors.length === 0}>
          <TriangleAlert className={errors.length ? 'text-destructive' : ''} />
          {errors.length === 0 ? 'No errors' : `${errors.length} ${errors.length === 1 ? 'error' : 'errors'}`}
        </Button>
        <Toggle size="sm" variant="outline" className="h-8" pressed={errorsOnly} onPressedChange={setErrorsOnly} disabled={errors.length === 0}>
          Errors with context
        </Toggle>
        <Toggle size="sm" variant="outline" className="h-8" pressed={hideSteps} onPressedChange={setHideSteps} title="Hide Jenkins' own [Pipeline] lines">
          Hide steps
        </Toggle>
        <Toggle size="sm" variant="outline" className="h-8" pressed={wrap} onPressedChange={setWrap} aria-label="Wrap long lines">
          <WrapText />
        </Toggle>

        <div className="ml-auto flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Copy the log"
            onClick={() =>
              navigator.clipboard.writeText(log.replace(ANSI, '')).then(
                () => toast.success('Log copied'),
                () => toast.error('Could not copy the log'),
              )
            }
          >
            <Copy />
          </Button>
          <Button asChild size="sm" variant="ghost" className="h-8">
            <a href={fullUrl} target="_blank" rel="noreferrer">
              Full log <ExternalLink />
            </a>
          </Button>
        </div>
      </div>

      {live && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-info-soft/50 px-3 py-1.5 text-xs">
          <span aria-hidden className="log-live-dot size-2 rounded-full bg-info" />
          <span className="font-medium text-info">Live</span>
          <span className="text-muted-foreground">
            {runningStage ? <>in {runningStage}</> : 'starting'} · <span aria-live="polite">{follow ? 'following the end — scroll up to pause' : 'paused while you read'}</span>
          </span>
          {!follow && (
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={resume}>
              Follow again
            </Button>
          )}
        </div>
      )}

      {truncated && (
        <p className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          Showing the end of a long log — line numbers count from where it starts here. The full log is in Jenkins.
        </p>
      )}

      <div className="relative">
        <div
          ref={box}
          onScroll={onScroll}
          tabIndex={0}
          role="region"
          aria-label="Console log"
          className="relative max-h-[70vh] min-h-48 overflow-auto font-mono text-xs leading-5 [overflow-anchor:none]"
        >
          <div ref={content} className="pb-2">
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-muted-foreground">{live ? 'Waiting for the first lines…' : 'The log is empty.'}</p>
          ) : (
            visible.map((line, i) => {
              const gap = i > 0 && line.n - visible[i - 1]!.n > 1
              return (
                // Siblings, not wrapped: a pinned heading sticks only within its parent, and that must be the whole log.
                <Fragment key={line.n}>
                  {gap && <div className="my-1 border-y border-dashed px-3 text-[11px] text-muted-foreground select-none">⋯ {line.n - visible[i - 1]!.n - 1} lines hidden</div>}
                  <LogLine line={line} wrap={wrap} needle={needle} active={line.n === target} timed={timed} fresh={live && line.n > seen.upTo} />
                </Fragment>
              )
            })
          )}
          {live && (
            <div className="flex border-l-2 border-l-transparent text-muted-foreground select-none" aria-hidden>
              <span className="w-14 shrink-0" />
              <span className="w-4 shrink-0" />
              {timed && <span className="hidden w-[4.75rem] shrink-0 sm:block" />}
              <span className="log-cursor">▍</span>
            </div>
          )}
          </div>
        </div>

        {live && !follow && (
          <Button
            size="sm"
            variant="secondary"
            onClick={resume}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md ring-1 ring-border"
          >
            <ArrowDown /> Jump to latest
            {unseen > 0 && <span className="text-muted-foreground tabular-nums">· {unseen} new {unseen === 1 ? 'line' : 'lines'}</span>}
          </Button>
        )}
      </div>
    </div>
  )
}

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

function LogLine({ line, wrap, needle, active, timed, fresh }: { line: Line; wrap: boolean; needle: string; active: boolean; timed: boolean; fresh: boolean }) {
  const text = line.kind === 'stage' ? STAGE.exec(line.text)![1]! : line.kind === 'command' ? line.text.slice(2) : line.text
  return (
    <div
      data-line={line.n}
      className={`flex border-l-2 hover:bg-muted/50 ${TONE[line.kind]} ${active ? 'bg-secondary!' : ''} ${fresh ? 'reveal' : ''}`}
      // A pinned heading must always be drawn: content-visibility would skip it once its own spot scrolled away.
      style={line.kind === 'stage' ? undefined : { contentVisibility: 'auto', containIntrinsicSize: 'auto 20px' }}
    >
      <span className="w-14 shrink-0 pr-3 text-right font-normal text-muted-foreground/60 tabular-nums select-none">{line.n}</span>
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
      {line.kind === 'stage' && <span className="text-muted-foreground font-normal select-none">Stage&nbsp;</span>}
      {line.kind === 'command' && (
        <span className="text-[var(--chart-1)] select-none" aria-label="Command:">
          $&nbsp;
        </span>
      )}
      <span className={`min-w-0 pr-4 ${wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'}`}>{highlight(text, needle)}</span>
    </div>
  )
}

/** The text with every occurrence of the find term marked. */
function highlight(text: string, needle: string): React.ReactNode {
  if (!needle) return text || ' '
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at), <mark key={at} className="rounded-sm bg-warning-soft px-0.5 text-foreground ring-1 ring-warning/40">{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return parts
}
