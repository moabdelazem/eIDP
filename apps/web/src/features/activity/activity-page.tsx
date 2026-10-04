import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Bot, KeyRound, LogIn, RefreshCw, Search, ShieldCheck, TriangleAlert, Inbox, UserRound, X, type LucideIcon } from 'lucide-react'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { Kpi, signed } from '@/components/kpi.tsx'
import { PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { BarsSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { since } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { activityApi, WINDOW_LABEL, type Activity, type ActivityWindow, type Group, type Overview, type Person } from './api.ts'

const ActivePeopleChart = lazy(() => import('./charts.tsx').then((m) => ({ default: m.ActivePeopleChart })))
const PagesChart = lazy(() => import('./charts.tsx').then((m) => ({ default: m.PagesChart })))

const TABS = ['overview', 'feed', 'people'] as const
type Tab = (typeof TABS)[number]

const GROUP: Record<Group, { label: string; icon: LucideIcon | typeof JenkinsIcon }> = {
  'sign-in': { label: 'Sign-ins', icon: LogIn },
  requests: { label: 'Requests', icon: Inbox },
  access: { label: 'Access', icon: ShieldCheck },
  jenkins: { label: 'Jenkins', icon: JenkinsIcon },
  ai: { label: 'AI', icon: Bot },
}

/**
 * Platform activity: who uses the portal and what they do in it, for DevOps.
 *
 * Across the top, the window's headline numbers against the window before,
 * and a callout when one name keeps being refused at sign-in — a lockout in
 * the making, or someone guessing. Then three tabs, all in the URL with the
 * window and filters, so a link lands on one view: the **Overview** (people
 * active over time, the parts of the portal they open, who did most), the
 * **Feed** (everything people did, in sentences, a day at a time — narrowed
 * by person, kind and words), and **People** (each person's window at a
 * glance). Page visits count toward the numbers but are not lines in the
 * feed. Mounted behind `activity.view`, which the API checks again.
 */
export function ActivityPage() {
  usePageTitle('Platform activity')
  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'overview'
  const window: ActivityWindow = (['24h', '7d', '30d'] as const).find((w) => w === params.get('window')) ?? '7d'
  const set = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(changes)) {
          if (!value) next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true },
    )
  const showPerson = (uid: string) => set({ tab: 'feed', who: uid, group: null, q: null })

  const overview = useResource(() => activityApi.overview(window), [window])
  const [stamp, setStamp] = useState(0)
  const refresh = () => {
    overview.reload()
    setStamp((s) => s + 1)
  }

  return (
    <div className={`${PAGE} space-y-6`}>
      <PageHeader
        title="Platform activity"
        description="Who uses the portal and what they do in it: sign-ins, the pages people open, requests, decisions, actions on Jenkins and access, and AI use."
        actions={
          <>
            <ToggleGroup type="single" variant="outline" size="sm" value={window} onValueChange={(v) => v && set({ window: v === '7d' ? null : v })} aria-label="Time window">
              {(Object.keys(WINDOW_LABEL) as ActivityWindow[]).map((w) => (
                <ToggleGroupItem key={w} value={w} className="px-3" aria-label={`Last ${WINDOW_LABEL[w]}`}>
                  {WINDOW_LABEL[w]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button size="sm" variant="outline" onClick={refresh} disabled={overview.loading}>
              <RefreshCw className={overview.loading ? 'animate-spin motion-reduce:animate-none' : ''} /> Refresh
            </Button>
          </>
        }
      />

      {overview.error && !overview.data ? (
        <EmptyState title="Activity can’t be shown" icon={TriangleAlert} action={<Button variant="outline" onClick={overview.reload}>Try again</Button>}>
          {overview.error}
        </EmptyState>
      ) : !overview.data ? (
        <Loading label="Loading activity…">
          <RowsSkeleton rows={2} />
        </Loading>
      ) : (
        <Headline data={overview.data} onPerson={(uid) => set({ tab: 'feed', who: uid, group: 'sign-in', q: null })} />
      )}

      <Tabs value={tab} onValueChange={(v) => set({ tab: v === 'overview' ? null : v })}>
        <div className="-mx-1 max-w-full overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="feed">Feed</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4 grid grid-cols-[minmax(0,1fr)]">
          {overview.data ? (
            <OverviewTab data={overview.data} window={window} onPerson={showPerson} />
          ) : (
            <Loading label="Loading activity…">
              <BarsSkeleton />
            </Loading>
          )}
        </TabsContent>

        <TabsContent value="feed" className="mt-4 grid grid-cols-[minmax(0,1fr)]">
          <FeedTab
            key={stamp}
            window={window}
            who={params.get('who') ?? ''}
            group={(Object.keys(GROUP) as Group[]).find((g) => g === params.get('group')) ?? null}
            q={params.get('q') ?? ''}
            set={set}
          />
        </TabsContent>

        <TabsContent value="people" className="mt-4 grid grid-cols-[minmax(0,1fr)]">
          <PeopleTab key={stamp} window={window} onPerson={showPerson} retentionDays={overview.data?.retentionDays ?? null} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** A headline count against the window before; `good` says which way is better, or null when neither is. */
function delta({ now, before }: { now: number; before: number }, good: 'up' | 'down' | null) {
  return { change: now - before, text: signed(now - before), good }
}

function Headline({ data, onPerson }: { data: Overview; onPerson: (uid: string) => void }) {
  const t = data.totals
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="People active" value={t.people.now.toLocaleString()} detail={`${t.people.before.toLocaleString()} the window before`} delta={delta(t.people, 'up')} />
        <Kpi
          label="Sign-ins"
          value={t.signIns.now.toLocaleString()}
          detail={t.failedSignIns.now ? `${t.failedSignIns.now.toLocaleString()} refused` : 'None refused'}
          delta={delta(t.signIns, null)}
        />
        <Kpi label="Pages opened" value={t.visits.now.toLocaleString()} detail="A page, once per half minute" delta={delta(t.visits, null)} />
        <Kpi label="Requests filed" value={t.requests.now.toLocaleString()} detail={`${t.decisions.now.toLocaleString()} decided`} delta={delta(t.requests, null)} />
        <Kpi label="Actions" value={t.actions.now.toLocaleString()} detail="On Jenkins and on access" delta={delta(t.actions, null)} />
        <Kpi label="AI questions" value={t.ai.now.toLocaleString()} detail="To the chatbot, and why builds failed" delta={delta(t.ai, null)} />
      </div>

      {data.refused.length > 0 && (
        <Alert className="reveal">
          <TriangleAlert className="text-warning" />
          <AlertTitle>{data.refused.length === 1 ? 'One name keeps being refused at sign-in' : `${data.refused.length} names keep being refused at sign-in`}</AlertTitle>
          <AlertDescription>
            <p>Five or more refusals in the window: an account locking itself out, a password changed somewhere else, or someone guessing.</p>
            <ul className="mt-2 space-y-1.5">
              {data.refused.map((r) => (
                <li key={r.uid} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <button type="button" onClick={() => onPerson(r.uid)} className="font-mono text-foreground underline-offset-2 hover:underline">
                    {r.uid}
                  </button>
                  <span>
                    {r.count} times · {r.reasons.join(', ')} · last {since(r.last)}
                  </span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

function OverviewTab({ data, window, onPerson }: { data: Overview; window: ActivityWindow; onPerson: (uid: string) => void }) {
  const quiet = data.series.every((s) => s.people === 0)
  return (
    <Split
      className=""
      aside={
        <Section title="Most active" description="By what they did — sign-ins, requests, decisions, actions and AI questions. Pages opened are not counted.">
          {data.people.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody did anything in the window.</p>
          ) : (
            <ol className="space-y-2">
              {data.people.map((p, i) => (
                <li key={p.uid} className="flex items-center gap-3 text-sm">
                  <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <button type="button" onClick={() => onPerson(p.uid)} className="min-w-0 flex-1 truncate text-left hover:underline" title={`Show what ${p.name} did`}>
                    {p.name} <span className="font-mono text-xs text-muted-foreground">{p.uid}</span>
                  </button>
                  <span className="text-xs text-muted-foreground tabular-nums">{p.value.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </Section>
      }
    >
      <Section title="People active" description={window === '24h' ? 'Distinct people each hour.' : 'Distinct people each day (UTC).'}>
        {quiet ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Nobody used the portal in the last {WINDOW_LABEL[window]}.</p>
        ) : (
          <Suspense fallback={<BarsSkeleton />}>
            <ActivePeopleChart series={data.series} window={window} />
          </Suspense>
        )}
      </Section>
      <Section title="Where people go" description="Pages opened, by part of the portal.">
        {data.sections.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No pages opened in the window.</p>
        ) : (
          <Suspense fallback={<BarsSkeleton />}>
            <PagesChart sections={data.sections} />
          </Suspense>
        )}
      </Section>
    </Split>
  )
}

// ---- the feed ---------------------------------------------------------------------------

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function FeedTab({
  window,
  who,
  group,
  q,
  set,
}: {
  window: ActivityWindow
  who: string
  group: Group | null
  q: string
  set: (changes: Record<string, string | null>) => void
}) {
  const [items, setItems] = useState<Activity[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  // Typed words reach the URL (and the API) once typing pauses.
  const [words, setWords] = useState(q)
  useEffect(() => {
    if (words === q) return
    const timer = setTimeout(() => set({ q: words.trim() || null }), 300)
    return () => clearTimeout(timer)
  }, [words, q, set])

  useEffect(() => {
    let stale = false
    setItems(null)
    setError(null)
    activityApi
      .feed({ window, who: who || undefined, group: group ?? undefined, q: q || undefined })
      .then((page) => {
        if (stale) return
        setItems(page.items)
        setNext(page.next)
      })
      .catch((err: unknown) => !stale && setError(err instanceof ApiError ? err.message : 'The feed could not be read.'))
    return () => {
      stale = true
    }
  }, [window, who, group, q])

  async function loadMore() {
    if (!next) return
    setMore(true)
    try {
      const page = await activityApi.feed({ window, who: who || undefined, group: group ?? undefined, q: q || undefined, before: next })
      setItems((list) => [...(list ?? []), ...page.items.filter((i) => !list?.some((x) => x.id === i.id))])
      setNext(page.next)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'More could not be read.')
    } finally {
      setMore(false)
    }
  }

  // A day at a time; the same thing done again and again in a row (six refused
  // sign-ins) is one line with a count, or it buries everything around it.
  const days = useMemo(() => {
    const grouped = new Map<string, Run[]>()
    for (const item of items ?? []) {
      const list = grouped.get(day(item.at)) ?? []
      const last = list.at(-1)
      if (last && same(last.item, item)) last.times++
      else list.push({ item, times: 1 })
      grouped.set(day(item.at), list)
    }
    return [...grouped.entries()]
  }, [items])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search the feed" placeholder="A name, a job, a project…" value={words} onChange={(e) => setWords(e.target.value)} className="pl-8" />
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={group ?? 'all'} onValueChange={(v) => v && set({ group: v === 'all' ? null : v })} aria-label="What happened" className="flex-wrap">
          <ToggleGroupItem value="all" className="px-3">
            Everything
          </ToggleGroupItem>
          {(Object.keys(GROUP) as Group[]).map((g) => (
            <ToggleGroupItem key={g} value={g} className="px-3">
              {GROUP[g].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {who && (
          <span className="inline-flex items-center gap-1 rounded-full border bg-secondary py-0.5 pr-1 pl-2.5 text-sm text-secondary-foreground">
            <UserRound className="size-3.5" aria-hidden /> <span className="font-mono">{who}</span>
            <button type="button" onClick={() => set({ who: null })} className="rounded-full p-0.5 hover:bg-background/60" aria-label={`Show everyone, not only ${who}`}>
              <X className="size-3.5" />
            </button>
          </span>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!items ? (
        !error && (
          <Loading label="Loading the feed…">
            <RowsSkeleton rows={6} />
          </Loading>
        )
      ) : days.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {who || group || q ? 'Nothing in the window matches.' : `Nothing happened in the last ${WINDOW_LABEL[window]}.`}
        </p>
      ) : (
        <>
          {days.map(([label, list]) => (
            <section key={label} className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <h3 className="border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">{label}</h3>
              <ol className="divide-y">
                {list.map((run) => (
                  <Line key={run.item.id} run={run} onPerson={(uid) => set({ who: uid })} />
                ))}
              </ol>
            </section>
          ))}
          {next && (
            <Button variant="outline" className="w-full" onClick={() => void loadMore()} disabled={more}>
              {more && <Spinner />} Show older
            </Button>
          )}
        </>
      )}
    </div>
  )
}

/** One line of the feed, and how many times in a row it happened; `item` is the newest of them. */
type Run = { item: Activity; times: number }
const same = (a: Activity, b: Activity) => a.uid === b.uid && a.kind === b.kind && a.target === b.target && a.note === b.note && a.ok === b.ok

function Line({ run: { item, times }, onPerson }: { run: Run; onPerson: (uid: string) => void }) {
  const Icon = item.kind === 'sign_in_failed' ? KeyRound : GROUP[item.group].icon
  const tone = !item.ok ? 'bg-warning-soft text-warning' : 'bg-muted text-muted-foreground'
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${tone}`} aria-label={GROUP[item.group].label}>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <button type="button" onClick={() => onPerson(item.uid)} className="font-medium hover:underline" title={`Only ${item.name}`}>
            {item.name}
          </button>
          <span className="text-muted-foreground">{item.verb}</span>
          {times > 1 && <span className="rounded-full border bg-muted/40 px-1.5 text-xs text-muted-foreground tabular-nums">×{times}</span>}
          {item.target &&
            (item.link ? (
              <Link to={item.link} className="font-mono text-xs underline-offset-2 hover:underline">
                {item.target}
              </Link>
            ) : (
              <span className="font-mono text-xs">{item.target}</span>
            ))}
          {!item.target && item.link && (
            <Link to={item.link} className="text-xs underline-offset-2 hover:underline">
              Open
            </Link>
          )}
        </p>
        {(item.note || item.name !== item.uid) && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.name !== item.uid && <span className="font-mono">{item.uid}</span>}
            {item.name !== item.uid && item.note && ' · '}
            {item.note && <span className={item.ok ? '' : 'text-warning'}>{item.note}</span>}
          </p>
        )}
      </div>
      <time dateTime={item.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(item.at).toLocaleString()}>
        {time(item.at)}
      </time>
    </li>
  )
}

// ---- people -----------------------------------------------------------------------------

function PeopleTab({ window, onPerson, retentionDays }: { window: ActivityWindow; onPerson: (uid: string) => void; retentionDays: number | null }) {
  const people = useResource(() => activityApi.people(window), [window])
  const [q, setQ] = useState('')
  if (people.error && !people.data) return <p className="text-sm text-destructive">{people.error}</p>
  if (!people.data) {
    return (
      <Loading label="Loading people…">
        <RowsSkeleton rows={6} />
      </Loading>
    )
  }
  const needle = q.trim().toLowerCase()
  const shown = people.data.filter((p) => !needle || p.uid.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))
  const n = (value: number) => (value ? value.toLocaleString() : <span className="text-muted-foreground/60">0</span>)

  return (
    <div className="space-y-4">
      <div className="relative min-w-56 sm:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input aria-label="Find a person" placeholder="Name or login" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {people.data.length === 0 ? `Nobody used the portal in the last ${WINDOW_LABEL[window]}.` : 'Nobody matches.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="pl-4">Person</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Sign-ins</TableHead>
                <TableHead className="text-right">Pages</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Decisions</TableHead>
                <TableHead className="text-right">Actions</TableHead>
                <TableHead className="text-right">AI</TableHead>
                <TableHead className="pr-4">Mostly in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p: Person) => (
                <TableRow key={p.uid}>
                  <TableCell className="pl-4">
                    <button type="button" onClick={() => onPerson(p.uid)} className="text-left hover:underline" title={`Show what ${p.name} did`}>
                      <span className="block font-medium">{p.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{p.uid}</span>
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground" title={new Date(p.lastSeen).toLocaleString()}>
                    {since(p.lastSeen)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {n(p.signIns)}
                    {p.failedSignIns > 0 && (
                      <span className="block text-xs text-warning" title="Refused sign-ins">
                        {p.failedSignIns} refused
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{n(p.visits)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(p.requests)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(p.decisions)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(p.actions)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(p.ai)}</TableCell>
                  <TableCell className="pr-4 text-muted-foreground">{p.topSection ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Sign-ins, pages opened and chatbot questions are kept {retentionDays ?? 90} days; requests, decisions and actions for as long as their own records are. Questions are counted, never stored here; pages are kept as their path, never what was searched.
      </p>
    </div>
  )
}
