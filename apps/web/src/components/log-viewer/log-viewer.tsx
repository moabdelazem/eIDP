import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  Layers,
  Link2,
  Maximize2,
  Minimize2,
  Search,
  Settings2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Toggle } from '@/components/ui/toggle'
import { parseLog, parseRange, rangeHash, STAGE, stagesOf, stripAnsi, type Kind, type Line } from './parse.ts'
import { useLogPrefs, SIZES } from './prefs.ts'

/**
 * A console log, made readable — the one log viewer in the app: the build
 * page's (Jenkins and My pipelines), and every `log` block the chatbot quotes.
 *
 * Numbered lines, errors and warnings marked (with an icon, not colour
 * alone), pipeline stages as headings pinned while their lines scroll under
 * them, shell commands as `$ …`, `timestamps {}` prefixes as a column. Find
 * with next/previous; jump error to error or to a stage; "errors with
 * context" and "hide steps" for reading a failure without Jenkins' own
 * bookkeeping — find wins over both, and a run of hidden lines opens with a
 * click. Opens at the first error when there is one, else at the end.
 *
 * **Expand** (or `f`) lifts the same viewer — find, filters, selection and
 * live following intact — into a dialog nearly the size of the window; Esc
 * returns, to the same line.
 * A line number selects a line (shift: a range) to copy, and on a `linkable`
 * page puts `#L12-L20` in the address, which opens the log there next time.
 * Wrap, step hiding, timestamps and text size are kept per browser.
 *
 * While the build runs (`live`) it is a tail: it opens at the end and keeps
 * to it as lines arrive, new lines fading in. Scrolling up pauses that, and
 * "Jump to latest" (or scrolling back down) takes it up again.
 */
export function LogViewer({
  log,
  truncated = false,
  fullUrl,
  jump,
  live = false,
  linkable = false,
  title,
  fileName = 'console',
  compact = false,
}: {
  log: string
  /** Only the end of a longer log is shown; line numbers count from where it starts. */
  truncated?: boolean
  /** Where the whole log is, when there is more than this. */
  fullUrl?: string
  /** The build is still running and the log still growing. */
  live?: boolean
  /** A line to show from outside — the explanation's evidence. `at` makes the same line jumpable twice. */
  jump?: { line: number; at: number } | null
  /** Selected lines go into the address as `#L12-L20`, and the log opens there. Only on a page that is the log's home. */
  linkable?: boolean
  /** Named in the expanded view's header. */
  title?: string
  /** The download's name, without `.log`. */
  fileName?: string
  /** A quoted log inside something else (a chat answer): a short box and a lighter toolbar. */
  compact?: boolean
}) {
  // A cut log starts mid-way; its numbers are relative to what is shown, so a link to one would drift.
  const links = linkable && !truncated
  const lines = useMemo(() => parseLog(log), [log])
  const errors = useMemo(() => lines.filter((l) => l.kind === 'error').map((l) => l.n), [lines])
  const stages = useMemo(() => stagesOf(lines), [lines])
  const [prefs, setPref] = useLogPrefs()
  const { wrap, hideSteps, times, size } = prefs

  const [expanded, setExpanded] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [find, setFind] = useState('')
  const [current, setCurrent] = useState(0)
  // A link's lines, else the first error — where a failed build explains itself — unless it still runs, when the end is the news.
  const [selection, setSelection] = useState<[number, number] | null>(() => (links ? parseRange(window.location.hash) : null))
  const anchor = useRef<number | null>(selection?.[0] ?? null)
  const [focusLine, setFocusLine] = useState<number | null>(() => selection?.[0] ?? (live ? null : (errors[0] ?? null)))
  // Runs of hidden lines someone opened.
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set())
  const box = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)

  // Following the end of a running log; the last line seen when it paused, to count what came since.
  const [follow, setFollow] = useState(live && !selection)
  const last = lines.at(-1)?.n ?? 0
  const [pausedAt, setPausedAt] = useState(last)
  // Lines that arrived in the latest update fade in; everything there on first sight does not.
  const [seen, setSeen] = useState({ upTo: last, prev: last })
  if (seen.prev !== last) setSeen({ upTo: seen.prev, prev: last })

  const needle = find.trim().toLowerCase()
  const matches = useMemo(() => (needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)).map((l) => l.n) : []), [lines, needle])
  // A jump from outside wins over find, and brings the log into view.
  const [shownJump, setShownJump] = useState(jump)
  if (jump && jump !== shownJump) {
    setShownJump(jump)
    setFind('')
    setFocusLine(jump.line)
  }
  const outer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!jump || !outer.current || expanded) return
    // The window, not scrollIntoView: that scrolls every ancestor, and shifted the sidebar rail.
    window.scrollTo({ top: outer.current.getBoundingClientRect().top + window.scrollY - 72 })
  }, [jump, expanded])

  // A new term starts from its first match.
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
  // step through lines nobody can see. So do selected and opened lines.
  const matched = new Set(matches)
  const visible = lines.filter(
    (l) =>
      matched.has(l.n) ||
      l.n === focusLine ||
      revealed.has(l.n) ||
      (selection !== null && l.n >= selection[0] && l.n <= selection[1]) ||
      ((!hideSteps || l.kind !== 'step') && (!errorsOnly || nearError.has(l.n) || l.kind === 'stage')),
  )

  // Where to look: the find result being stepped through, else a jumped-to line.
  const target = needle && matches.length ? matches[current % matches.length]! : focusLine
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${target}"]`)
    // Scrolled within the log only: scrollIntoView would scroll the page too,
    // and on a long page that shifts the sidebar rail out from under you.
    if (target === null || !el || !box.current) return
    box.current.scrollTop = el.offsetTop - box.current.clientHeight / 3
  }, [target, errorsOnly, hideSteps, jump])

  // With no error to open at, open at the end, where the build finished (or is now).
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !box.current) return
    opened.current = true
    if ((errors.length === 0 || live) && !selection) box.current.scrollTop = box.current.scrollHeight
  }, [errors, live, selection])

  // Following: every update lands at the end, before it is painted. The last
  // one — the build finishing — lands there too, and then following stops.
  useLayoutEffect(() => {
    if (!follow || !box.current) return
    box.current.scrollTop = box.current.scrollHeight
    if (!live) setFollow(false)
  }, [follow, live, lines, hideSteps, errorsOnly, wrap, size, expanded])

  // Lines below the fold take their real (wrapped) height only once drawn, so
  // the end moves after the jump to it: while following, stay pinned to it.
  // Expanding draws the box anew, so the observer follows it.
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
  }, [expanded])

  // Expanding or closing redraws the box at another width: keep the line that was at the top at the top.
  const topLine = useRef<number | null>(null)
  const toggleExpanded = () => {
    const el = box.current
    if (el) {
      const first = [...el.querySelectorAll<HTMLElement>('[data-line]')].find((l) => l.offsetTop + l.offsetHeight > el.scrollTop + 1)
      topLine.current = first ? Number(first.dataset.line) : null
    }
    setExpanded((x) => !x)
  }
  useLayoutEffect(() => {
    const el = box.current
    if (!el || following.current || topLine.current === null) return
    const line = el.querySelector<HTMLElement>(`[data-line="${topLine.current}"]`)
    if (line) el.scrollTop = line.offsetTop
    topLine.current = null
  }, [expanded])

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
  const timed = times && lines.some((l) => l.time)

  const step = (by: number) => setCurrent((c) => (c + by + matches.length) % Math.max(matches.length, 1))
  const goTo = (line: number) => {
    setFind('')
    setFollow(false)
    setFocusLine(line)
  }
  const nextError = (by: number) => {
    if (errors.length === 0) return
    const from = focusLine ?? 0
    goTo(by > 0 ? (errors.find((n) => n > from) ?? errors[0]!) : ([...errors].reverse().find((n) => n < from) ?? errors.at(-1)!))
  }

  // A line number selects; shift extends from the last one picked.
  const select = (n: number, extend: boolean) => {
    const range: [number, number] = extend && anchor.current !== null ? [Math.min(anchor.current, n), Math.max(anchor.current, n)] : [n, n]
    if (!extend) anchor.current = n
    setSelection(range)
    setFocusLine(range[0])
    if (links) window.history.replaceState(window.history.state, '', rangeHash(range))
  }
  const clearSelection = () => {
    setSelection(null)
    anchor.current = null
    if (links && window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${what} copied`),
      () => toast.error(`Could not copy the ${what.toLowerCase()}`),
    )
  const selectedText = () => (selection ? lines.filter((l) => l.n >= selection[0] && l.n <= selection[1]).map((l) => l.text).join('\n') : '')
  const download = () => {
    const url = URL.createObjectURL(new Blob([stripAnsi(log)], { type: 'text/plain' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `${fileName.replace(/[^\w.-]+/g, '-')}.log` })
    a.click()
    URL.revokeObjectURL(url)
  }

  // Keys, while focus is in the viewer and not typing in find.
  const onKeyDown = (e: KeyboardEvent) => {
    // React bubbles events out of portals: Esc closing the stage menu, or its typeahead, is the menu's, not ours.
    if (!(e.target instanceof Node) || !outer.current?.contains(e.target)) return
    const typing = e.target instanceof HTMLInputElement
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      findInput.current?.focus()
      findInput.current?.select()
      return
    }
    if (e.key === 'Escape') {
      // Expanded, Radix closes the dialog on Esc (see onEscapeKeyDown below).
      if (typing && find) setFind('')
      else if (!expanded && selection) clearSelection()
      else return
      e.preventDefault()
      return
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return
    const keys: Record<string, () => void> = {
      '/': () => findInput.current?.focus(),
      e: () => nextError(1),
      E: () => nextError(-1),
      f: toggleExpanded,
      w: () => setPref('wrap', !wrap),
    }
    if (keys[e.key]) {
      e.preventDefault()
      keys[e.key]!()
    }
  }

  const gapFrom = (i: number) => (i > 0 ? visible[i - 1]!.n : 0)
  const sizing = SIZES[size]

  const frame = (
    <div ref={outer} onKeyDown={onKeyDown} className={expanded ? 'flex min-h-0 flex-1 flex-col' : 'overflow-hidden rounded-xl border bg-card'}>
      {expanded && (
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">{title ?? 'Log'}</DialogTitle>
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            <Kbd>Esc</Kbd> to close
          </span>
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setExpanded(false)} aria-label="Close the expanded log">
            <X />
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className={`relative min-w-36 flex-1 ${compact ? '' : 'basis-[calc(100%-5rem)] sm:max-w-xs sm:basis-auto'}`}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={findInput}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              }
            }}
            placeholder={compact ? "Find" : "Find in log"}
            aria-label="Find in log"
            aria-keyshortcuts="/"
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

        {!compact && <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />}

        <Button size="sm" variant="outline" className="h-8" onClick={() => nextError(1)} disabled={errors.length === 0} title="Next error (e, shift+e for the one before)">
          <TriangleAlert className={errors.length ? 'text-destructive' : ''} />
          {errors.length === 0 ? 'No errors' : `${errors.length} ${errors.length === 1 ? 'error' : 'errors'}`}
        </Button>
        {!compact && (
          <Toggle size="sm" variant="outline" className="h-8" pressed={errorsOnly} onPressedChange={setErrorsOnly} disabled={errors.length === 0}>
            Errors with context
          </Toggle>
        )}
        {stages.length > (compact ? 1 : 0) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8">
                <Layers /> Stages <ChevronDown className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
              <DropdownMenuLabel>Go to a stage</DropdownMenuLabel>
              {stages.map((s) => (
                <DropdownMenuItem key={s.line} onSelect={() => goTo(s.line)}>
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.errors > 0 && (
                    <span className="flex items-center gap-1 text-xs text-destructive tabular-nums">
                      <TriangleAlert className="size-3 text-destructive" aria-hidden />
                      {s.errors}
                      <span className="sr-only">{s.errors === 1 ? 'error' : 'errors'}</span>
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="ml-auto flex gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-8" aria-label="View settings">
                <Settings2 />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>View</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={(v) => setPref('wrap', v === true)} onSelect={(e) => e.preventDefault()}>
                Wrap long lines <DropdownMenuShortcut>W</DropdownMenuShortcut>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={hideSteps} onCheckedChange={(v) => setPref('hideSteps', v === true)} onSelect={(e) => e.preventDefault()}>
                Hide [Pipeline] steps
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={times} onCheckedChange={(v) => setPref('times', v === true)} onSelect={(e) => e.preventDefault()} disabled={!lines.some((l) => l.time)}>
                Show timestamps
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Text size</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={size} onValueChange={(v) => setPref('size', v as typeof size)}>
                <DropdownMenuRadioItem value="sm" onSelect={(e) => e.preventDefault()}>Small</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="md" onSelect={(e) => e.preventDefault()}>Medium</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="lg" onSelect={(e) => e.preventDefault()}>Large</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Keys: <Kbd>/</Kbd> find · <Kbd>e</Kbd> next error · <Kbd>f</Kbd> expand · <Kbd>w</Kbd> wrap
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Copy the log" onClick={() => void copy(stripAnsi(log), 'Log')}>
            <Copy />
          </Button>
          {!compact && (
            <Button size="icon" variant="ghost" className="size-8" aria-label="Download the log" onClick={download}>
              <Download />
            </Button>
          )}
          {fullUrl && (
            <Button asChild size="sm" variant="ghost" className="h-8">
              <a href={fullUrl} target="_blank" rel="noreferrer">
                Full log <ExternalLink />
              </a>
            </Button>
          )}
          <Button
            ref={expandButton}
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={toggleExpanded}
            aria-label={expanded ? 'Close the expanded log' : 'Expand the log'}
            aria-keyshortcuts="f"
            title={expanded ? 'Close (Esc)' : 'Expand (f)'}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
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
          Showing the end of a long log — line numbers count from where it starts here.{fullUrl && ' The full log is in Jenkins.'}
        </p>
      )}

      {selection && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b bg-secondary/40 px-3 py-1 text-xs">
          <span className="mr-1 font-medium">
            {selection[0] === selection[1] ? `Line ${selection[0]}` : `Lines ${selection[0]}–${selection[1]}`} selected
          </span>
          <span className="hidden text-muted-foreground sm:inline">· shift-click a number to extend</span>
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void copy(selectedText(), selection[0] === selection[1] ? 'Line' : 'Lines')}>
              <Copy /> Copy {selection[0] === selection[1] ? 'line' : 'lines'}
            </Button>
            {links && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void copy(window.location.href, 'Link')}>
                <Link2 /> Copy link
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={clearSelection} aria-label="Clear the selection">
              <X />
            </Button>
          </span>
        </div>
      )}

      <div className={expanded ? 'relative min-h-0 flex-1' : 'relative'}>
        <div
          ref={box}
          onScroll={onScroll}
          tabIndex={0}
          role="region"
          aria-label="Console log"
          className={`relative overflow-auto font-mono [overflow-anchor:none] focus-visible:outline-none ${sizing.text} ${
            expanded ? 'h-full' : compact ? 'max-h-80' : 'max-h-[70vh] min-h-48'
          }`}
        >
          <div ref={content} className="pb-2">
            {visible.length === 0 ? (
              <p className="px-4 py-6 text-muted-foreground">{live ? 'Waiting for the first lines…' : 'The log is empty.'}</p>
            ) : (
              visible.map((line, i) => {
                const hidden = i > 0 ? line.n - gapFrom(i) - 1 : 0
                return (
                  // Siblings, not wrapped: a pinned heading sticks only within its parent, and that must be the whole log.
                  <Fragment key={line.n}>
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="my-1 block w-full border-y border-dashed px-3 text-left text-[11px] text-muted-foreground select-none hover:bg-muted/60 hover:text-foreground"
                        onClick={() =>
                          setRevealed((r) => {
                            const next = new Set(r)
                            for (let k = gapFrom(i) + 1; k < line.n; k++) next.add(k)
                            return next
                          })
                        }
                      >
                        ⋯ {hidden} {hidden === 1 ? 'line' : 'lines'} hidden — show
                      </button>
                    )}
                    <LogLine
                      line={line}
                      wrap={wrap}
                      needle={needle}
                      active={line.n === target}
                      selected={selection !== null && line.n >= selection[0] && line.n <= selection[1]}
                      timed={timed}
                      fresh={live && line.n > seen.upTo}
                      rowHeight={sizing.row}
                      onSelect={select}
                    />
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
          <Button size="sm" variant="secondary" onClick={resume} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md ring-1 ring-border">
            <ArrowDown /> Jump to latest
            {unseen > 0 && <span className="text-muted-foreground tabular-nums">· {unseen} new {unseen === 1 ? 'line' : 'lines'}</span>}
          </Button>
        )}
      </div>
    </div>
  )

  if (!expanded) return frame
  // A Radix dialog rather than a portal of our own: it makes the page behind
  // inert and stacks with the one around it — the chatbot's dock is a sheet,
  // which would otherwise keep focus, and the pointer, to itself.
  return (
    <Dialog open onOpenChange={(open) => !open && setExpanded(false)}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden bg-card p-0 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-none"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          box.current?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          expandButton.current?.focus({ preventScroll: true })
        }}
        onEscapeKeyDown={(e) => {
          // Esc in find with something typed clears it first, as it does inline.
          if (document.activeElement === findInput.current && find) {
            e.preventDefault()
            setFind('')
          }
        }}
      >
        {frame}
      </DialogContent>
    </Dialog>
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

// A pinned heading scrolls over lines, so its selected fill is mixed opaque, never translucent.
const SELECTED_HEADING = 'bg-[color-mix(in_oklab,var(--secondary)_70%,var(--card))]!'

function LogLine({
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
