import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ChevronLeft, ChevronRight, RotateCcw, Search, SlidersHorizontal, Square, X } from 'lucide-react'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { since } from '@/features/requests/status.tsx'
import { useResource } from '@/lib/use-resource.ts'
import type { Pending } from './actions.tsx'
import { buildPath, duration, jenkinsApi, WINDOW_LABEL, type Parameter, type Result, type Run, type Window } from './api.ts'
import { JobName, RESULT, ResultBadge } from './result.tsx'

const PAGE_SIZE = 50
/** Parameters shown in a row before the rest fold into "+N". */
const CHIPS = 3

/**
 * Every build in the window, searchable by anything it carries — the job, a
 * parameter, what started it, the agent, its number. `NAME=value` narrows to
 * a parameter; words narrow each other. The search runs in the API over
 * history, so it covers every build in the window, not just a page of them.
 *
 * The search is the page's state in the URL (`q`, `result`), so a link to
 * "every deploy of release/2.3" can be sent to someone.
 */
export function Runs({
  window,
  version,
  q,
  result,
  onChange,
  canOperate,
  onAct,
}: {
  window: Window
  /** Bumped by Refresh and by actions, to read again. */
  version: number
  q: string
  result: Result | 'all'
  onChange: (next: { q?: string; result?: Result | 'all' }) => void
  canOperate: boolean
  onAct: (pending: Pending) => void
}) {
  // Typed text settles for a moment before it becomes the search.
  const [text, setText] = useState(q)
  // The URL can change under the box (a chip clicked, back pressed): follow it.
  const [shownQ, setShownQ] = useState(q)
  if (q !== shownQ) {
    setShownQ(q)
    setText(q)
  }
  useEffect(() => {
    if (text === q) return
    const timer = setTimeout(() => onChange({ q: text }), 300)
    return () => clearTimeout(timer)
  }, [text, q, onChange])

  // A new search starts at the newest builds.
  const [offset, setOffset] = useState(0)
  const filterKey = `${q}\n${result}\n${window}`
  const [shownFilter, setShownFilter] = useState(filterKey)
  if (filterKey !== shownFilter) {
    setShownFilter(filterKey)
    setOffset(0)
  }

  const page = useResource(
    () => jenkinsApi.runs({ window, q, result: result === 'all' ? undefined : result, limit: PAGE_SIZE, offset }),
    [window, q, result, offset, version],
    { pollMs: 30_000 },
  )
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const addTerm = (term: string) => {
    if (terms.includes(term.toLowerCase())) return
    onChange({ q: [q.trim(), term].filter(Boolean).join(' ') })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Job, parameter value, agent, #build — or NAME=value"
            className="pr-8 pl-8 font-mono text-sm"
            aria-label="Search builds"
          />
          {text && (
            <button
              type="button"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => onChange({ q: '' })}
              aria-label="Clear the search"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <ParameterPicker window={window} onPick={addTerm} />
        <Select value={result} onValueChange={(value) => onChange({ result: value as Result | 'all' })}>
          <SelectTrigger className="w-36" aria-label="Result">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any result</SelectItem>
            {(Object.keys(RESULT) as Result[]).map((key) => (
              <SelectItem key={key} value={key}>
                {RESULT[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {page.error && !page.data ? (
        <p className="text-sm text-destructive">{page.error}</p>
      ) : !page.data ? (
        <Loading label="Loading builds…">
          <RowsSkeleton rows={6} />
        </Loading>
      ) : (
        <>
          <div className={`rounded-xl border bg-card transition-opacity ${page.loading ? 'opacity-60' : ''}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Build</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="hidden md:table-cell">Parameters</TableHead>
                  <TableHead className="hidden sm:table-cell">Started</TableHead>
                  <TableHead className="hidden lg:table-cell">Took</TableHead>
                  <TableHead className="hidden xl:table-cell">Agent</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.data.runs.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      No builds in the {WINDOW_LABEL[window].toLowerCase()} match{q ? ` “${q}”` : ''}.
                    </TableCell>
                  </TableRow>
                ) : (
                  page.data.runs.map((run) => (
                    <TableRow key={`${run.job}#${run.number}`}>
                      <TableCell className="max-w-72">
                        <Link to={buildPath(run)} className="hover:underline">
                          <JobName name={run.job} className="text-sm" /> <span className="font-mono text-xs text-muted-foreground">#{run.number}</span>
                        </Link>
                        {run.causes[0] && <p className="mt-0.5 truncate text-xs text-muted-foreground">{run.causes[0]}</p>}
                      </TableCell>
                      <TableCell>
                        <ResultBadge result={run.result} />
                      </TableCell>
                      <TableCell className="hidden max-w-96 md:table-cell">
                        <ParameterChips parameters={run.parameters} terms={terms} onPick={addTerm} />
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell" title={new Date(run.startedAt).toLocaleString()}>
                        {since(run.startedAt)}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">
                        {run.result === 'running' ? '—' : duration(run.durationMs)}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground xl:table-cell">{run.builtOn ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        {canOperate && <RunAction run={run} onAct={onAct} />}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span className="tabular-nums">
              {page.data.total === 0
                ? 'No builds'
                : `${offset + 1}–${offset + page.data.runs.length} of ${page.data.total.toLocaleString()} builds`}{' '}
              · {WINDOW_LABEL[window].toLowerCase()}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft /> Newer
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE_SIZE >= page.data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Older <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Run again, or stop one still going — the one action a row offers. */
export function RunAction({ run, onAct }: { run: Pick<Run, 'job' | 'number' | 'result'>; onAct: (pending: Pending) => void }) {
  return run.result === 'running' ? (
    <Button size="sm" variant="outline" onClick={() => onAct({ kind: 'stop', build: run })} aria-label={`Stop ${run.job} #${run.number}`}>
      <Square /> <span className="hidden sm:inline">Stop</span>
    </Button>
  ) : (
    <Button size="sm" variant="outline" onClick={() => onAct({ kind: 'rebuild', build: run })} aria-label={`Run ${run.job} #${run.number} again`}>
      <RotateCcw /> <span className="hidden sm:inline">Run again</span>
    </Button>
  )
}

/**
 * A build's parameters as `NAME=value` chips — the first few inline, the rest
 * behind "+N" — each one a filter: click to search for builds that had it.
 * A chip the search already matches is marked, so it is clear why a row is here.
 */
export function ParameterChips({ parameters, terms, onPick }: { parameters: Parameter[]; terms: string[]; onPick: (term: string) => void }) {
  if (parameters.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  const shown = parameters.filter((p) => !p.hidden).slice(0, CHIPS)
  const rest = parameters.length - shown.length
  const matches = (p: Parameter) =>
    terms.some((t) => {
      const [name, value] = t.includes('=') ? t.split('=', 2) : [null, t]
      return (name === null || p.name.toLowerCase().includes(name)) && (p.value ?? '').toLowerCase().includes(value ?? '')
    })
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((p) => (
        <button
          key={p.name}
          type="button"
          onClick={() => onPick(`${p.name}=${p.value ?? ''}`)}
          title={`Show builds with ${p.name}=${p.value ?? ''}`}
          className={`max-w-48 truncate rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:border-ring ${
            matches(p) ? 'border-ring bg-secondary text-secondary-foreground' : 'bg-muted/40 text-muted-foreground'
          }`}
        >
          <span className="text-muted-foreground">{p.name}=</span>
          <span className="text-foreground">{p.value ?? '∅'}</span>
        </button>
      ))}
      {rest > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              +{rest}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
              {parameters.map((p) => (
                <div key={p.name} className="contents">
                  <dt className="opacity-70">{p.name}</dt>
                  <dd className="break-words">{p.value ?? '∅'}</dd>
                </div>
              ))}
            </dl>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * The parameters builds in the window used, each with its commonest values —
 * so finding "every build of release/2.3" does not start from remembering
 * that the parameter is called BRANCH. Picking one adds `NAME=value` to the search.
 */
function ParameterPicker({ window, onPick }: { window: Window; onPick: (term: string) => void }) {
  const [open, setOpen] = useState(false)
  const facets = useResource(() => (open ? jenkinsApi.parameters(window) : Promise.resolve(null)), [open, window])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="default">
          <SlidersHorizontal /> Parameter
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Parameter or value…" />
          <CommandList className="max-h-80">
            <CommandEmpty>{facets.loading ? 'Loading…' : 'No parameters in this window.'}</CommandEmpty>
            {(facets.data ?? []).map((facet) => (
              <CommandGroup key={facet.name} heading={facet.name}>
                {facet.values.map((v) => (
                  <CommandItem
                    key={v.value}
                    value={`${facet.name}=${v.value}`}
                    onSelect={() => {
                      onPick(`${facet.name}=${v.value}`)
                      setOpen(false)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{v.value}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{v.builds}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
