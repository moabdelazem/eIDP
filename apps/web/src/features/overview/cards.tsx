import { lazy, Suspense, useMemo, type ReactNode } from 'react'
import { AlertCircle, ArrowRight, Boxes, ChevronDown, ChevronRight, CircleCheck, Inbox, ListChecks, Plus, Server, TriangleAlert, Users, Workflow, type LucideIcon } from 'lucide-react'
import { AnimatePresence, m } from 'motion/react'
import { Link, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { BarsSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import type { Profile } from '@eidp/contracts/auth'
import { buildPath, jenkinsApi } from '@/features/jenkins/api.ts'
import { JobName, RESULT, ResultBadge } from '@/features/jenkins/result.tsx'
import { isBroken, pipelinesApi } from '@/features/pipelines/api.ts'
import { useCatalog } from '@/features/projects/catalog-context.tsx'
import { isInFlight, requestsApi } from '@/features/requests/api.ts'
import { NewRequestMenuContent } from '@/features/requests/new-request-menu.tsx'
import { RequestRow } from '@/features/requests/request-row.tsx'
import { since } from '@/features/requests/status.tsx'
import { useResource } from '@/lib/use-resource.ts'
import { CARDS, topWithOther, type CardInfo, type Viewer } from './card-list.ts'
import { StatTile } from '@/components/stat-tile.tsx'

// Recharts is most of the weight of the catalog card and nothing else's.
const RankedBars = lazy(() => import('./charts.tsx').then((module) => ({ default: module.RankedBars })))

/**
 * The Overview's cards. Each reads its own data under the same cache key the
 * full page uses (`['requests', 'mine']`, `['pipelines', 'mine', '7d']`…), so
 * the Overview and that page share one request and one answer.
 */

export function CardFrame({ info, action, children, flush = false }: { info: CardInfo; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <Card className={`h-full ${flush ? 'gap-0 py-0' : ''}`}>
      <CardHeader className={flush ? 'flex flex-row items-start justify-between gap-3 py-4' : 'flex flex-row items-start justify-between gap-3'}>
        <div className="min-w-0">
          <CardTitle className="text-sm">{info.title}</CardTitle>
          <CardDescription className="mt-1">{info.description}</CardDescription>
        </div>
        {action}
      </CardHeader>
      {flush ? children : <CardContent>{children}</CardContent>}
    </Card>
  )
}

const MoreLink = ({ to, label }: { to: string; label: string }) => (
  <Button asChild variant="ghost" size="sm" className="shrink-0">
    <Link to={to}>
      {label} <ArrowRight />
    </Link>
  </Button>
)

// ---- the shared reads -------------------------------------------------------

const useMine = () => useResource(['requests', 'mine'], () => requestsApi.mine(), { pollMs: 30_000 })
const usePool = (decider: boolean) =>
  useResource(decider ? ['requests', 'pool'] : ['requests', 'pool', 'none'], () => (decider ? requestsApi.pool() : Promise.resolve(null)), { pollMs: 30_000 })
const usePipelines = (on: boolean) =>
  useResource(on ? ['pipelines', 'mine', '7d'] : ['pipelines', 'mine', 'none'], () => (on ? pipelinesApi.mine('7d') : Promise.resolve(null)), { pollMs: 60_000 })
const useJenkins = (on: boolean) =>
  useResource(on ? ['jenkins', 'overview', 0] : ['jenkins', 'overview', 'none'], () => (on ? jenkinsApi.overview() : Promise.resolve(null)), { pollMs: 30_000 })

// ---- Needs you --------------------------------------------------------------

/** One thing to do: what it is, what opening it does (`hint`), and whether it asks someone to act or to read. */
type Need = { key: string; icon: LucideIcon; text: ReactNode; hint: string; to: string; tone: 'act' | 'look' }

/** Everything someone could act on now, from each part of the portal they can see. A count of it heads the page. */
export function useNeeds(v: Viewer): { needs: Need[]; loading: boolean } {
  const mine = useMine()
  const pool = usePool(v.decider)
  const pipes = usePipelines(v.pipelines)
  const jenkins = useJenkins(v.jenkins)
  const needs = useMemo(() => {
    const out: Need[] = []
    const pending = pool.data?.open.filter((r) => r.status === 'pending') ?? []
    if (pending.length) out.push({ key: 'decide', icon: ListChecks, text: `${pending.length} ${pending.length === 1 ? 'request waits' : 'requests wait'} for your decision`, to: '/approvals', hint: 'Decide in Approvals', tone: 'act' })
    const failedPool = pool.data?.open.filter((r) => r.status === 'failed') ?? []
    if (failedPool.length) out.push({ key: 'retry', icon: AlertCircle, text: `${failedPool.length} approved ${failedPool.length === 1 ? 'request' : 'requests'} failed and need a retry`, to: '/approvals', hint: 'Retry from Approvals', tone: 'act' })
    // A pushed pipeline whose provisioning or test build failed in Jenkins: the request is done, the step is not.
    for (const r of [...(pool.data?.open ?? []), ...(pool.data?.recent ?? [])].filter((r) => r.steps?.some((s) => s.status === 'failed')).slice(0, 5)) {
      const step = r.steps.find((s) => s.status === 'failed')!
      out.push({ key: `step-${r.id}`, icon: Workflow, text: <>{step.step === 'provision' ? 'Provisioning' : 'The first test build'} of <b className="font-medium">{r.pipeline?.application ?? r.repository}</b> failed in Jenkins</>, to: `/requests/${r.id}`, hint: 'Run it again from the request', tone: 'act' })
    }
    // Your own requests that went wrong in the last week: rejected (read why) or failed (DevOps retries; you may want to know).
    const week = Date.now() - 7 * 86_400_000
    for (const r of mine.data ?? []) {
      if ((r.status === 'rejected' || r.status === 'failed') && new Date(r.requestedAt).getTime() > week) {
        out.push({ key: `req-${r.id}`, icon: TriangleAlert, text: <>Your request for <b className="font-medium">{r.repository ?? r.project}</b> {r.status === 'rejected' ? 'was rejected' : 'failed'}</>, to: `/requests/${r.id}`, hint: r.status === 'rejected' ? 'Read why' : 'See what happened', tone: 'look' })
      }
    }
    for (const p of (pipes.data?.pipelines ?? []).filter((p) => isBroken(p.last.result)).slice(0, 5)) {
      out.push({ key: `pipe-${p.key}`, icon: Workflow, text: <><b className="font-medium">{p.job}</b>{p.applications.length ? ` (${p.applications.join(', ')})` : ''} is {p.last.result === 'unstable' ? 'unstable' : 'failing'}</>, to: buildPath(p.last, '/pipelines'), hint: 'Open the last build', tone: 'act' })
    }
    const j = jenkins.data
    if (j && j.counts.failing > 0) out.push({ key: 'jenkins-failing', icon: Server, text: `${j.counts.failing} Jenkins ${j.counts.failing === 1 ? 'job is' : 'jobs are'} failing`, to: '/jenkins?tab=failures', hint: 'See them in Jenkins', tone: 'act' })
    if (j && j.counts.agentsOffline > 0) out.push({ key: 'agents', icon: Server, text: `${j.counts.agentsOffline} Jenkins ${j.counts.agentsOffline === 1 ? 'agent is' : 'agents are'} offline`, to: '/jenkins?tab=agents', hint: 'See the agents', tone: 'act' })
    return out
  }, [mine.data, pool.data, pipes.data, jenkins.data])
  const loading = !mine.data && !mine.error
  return { needs, loading }
}

export function NeedsYouCard({ viewer }: { viewer: Viewer }) {
  const { needs, loading } = useNeeds(viewer)
  return (
    <CardFrame info={CARDS['needs-you']}>
      {loading ? (
        <RowsSkeleton rows={2} bordered={false} />
      ) : needs.length === 0 ? (
        // The greeting above already says nothing needs you; here, what would show up if something did.
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <span>All clear. Failing pipelines, requests waiting on you and anything of yours that went wrong show up here as they happen.</span>
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {/* Needs come and go as the portal polls: one arriving fades in, one dealt with fades out, and the rest close up. */}
          <AnimatePresence initial={false}>
            {needs.map((n) => (
              <m.li key={n.key} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.2 }}>
                <Item asChild variant="outline" size="sm" className="h-full bg-card">
                  <Link to={n.to}>
                    {/* Red only for what asks someone to act; the rest is to read. Never colour alone: an icon and the words. */}
                    <ItemMedia variant="icon" className={n.tone === 'act' ? 'border-destructive/20 bg-destructive/5 text-destructive' : 'border-warning/25 bg-warning-soft text-warning'}>
                      <n.icon aria-hidden />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="font-normal">
                        <span className="min-w-0">{n.text}</span>
                      </ItemTitle>
                      <ItemDescription className="text-xs">{n.hint}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover/item:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
                    </ItemActions>
                  </Link>
                </Item>
              </m.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </CardFrame>
  )
}

// ---- Waiting on you ---------------------------------------------------------

export function ApprovalsCard() {
  const pool = usePool(true)
  const pending = (pool.data?.open ?? []).filter((r) => r.status === 'pending' || r.status === 'failed')
  return (
    <CardFrame info={CARDS.approvals} flush action={pending.length > 0 && <MoreLink to="/approvals" label="Approvals" />}>
      {!pool.data ? (
        <div className="px-6 pb-4">{pool.error ? <p className="text-sm text-muted-foreground">{pool.error}</p> : <RowsSkeleton rows={3} bordered={false} />}</div>
      ) : pending.length === 0 ? (
        <p className="flex items-center gap-2 border-t px-6 py-6 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-success" aria-hidden /> Nothing is waiting for a decision.
        </p>
      ) : (
        <ul className="divide-y border-t">
          {[...pending]
            .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
            .slice(0, 5)
            .map((r) => (
              <li key={r.id}>
                <RequestRow request={r} showRequester />
              </li>
            ))}
        </ul>
      )}
    </CardFrame>
  )
}

// ---- Jenkins now -----------------------------------------------------------

export function JenkinsCard() {
  const jenkins = useJenkins(true)
  const j = jenkins.data
  // The same dots as Jenkins' own tiles, so the two read alike.
  const tiles: { label: string; n: number | undefined; to: string; dot: string; alarm: boolean }[] = [
    { label: 'Failing', n: j?.counts.failing, to: '/jenkins?tab=failures', dot: RESULT.failure.dot, alarm: (j?.counts.failing ?? 0) > 0 },
    { label: 'Running', n: j?.counts.running, to: '/jenkins?tab=runs', dot: RESULT.running.dot, alarm: false },
    { label: 'In queue', n: j?.counts.queued, to: '/jenkins?tab=queue', dot: 'bg-warning', alarm: false },
    { label: 'Agents down', n: j?.counts.agentsOffline, to: '/jenkins?tab=agents', dot: 'bg-destructive', alarm: (j?.counts.agentsOffline ?? 0) > 0 },
  ]
  return (
    <CardFrame info={CARDS.jenkins} action={<MoreLink to="/jenkins" label="Jenkins" />}>
      {jenkins.error && !j ? (
        <p className="text-sm text-muted-foreground">Jenkins can’t be read right now: {jenkins.error}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {tiles.map((t) => (
            <StatTile key={t.label} size="sm" label={t.label} value={t.n} dot={t.dot} alarm={t.alarm} to={t.to} />
          ))}
        </div>
      )}
    </CardFrame>
  )
}

// ---- Your pipelines --------------------------------------------------------

export function PipelinesCard() {
  const pipes = usePipelines(true)
  const list = [...(pipes.data?.pipelines ?? [])]
    .sort((a, b) => Number(isBroken(b.last.result)) - Number(isBroken(a.last.result)) || b.last.startedAt.localeCompare(a.last.startedAt))
    .slice(0, 6)
  return (
    <CardFrame info={CARDS.pipelines} flush action={list.length > 0 && <MoreLink to="/pipelines" label="My pipelines" />}>
      {!pipes.data ? (
        <div className="px-6 pb-4">{pipes.error ? <p className="text-sm text-muted-foreground">{pipes.error}</p> : <RowsSkeleton rows={3} bordered={false} />}</div>
      ) : list.length === 0 ? (
        <p className="border-t px-6 py-6 text-sm text-muted-foreground">No runs of yours or your teams’ in the last 7 days.</p>
      ) : (
        <ul className="divide-y border-t">
          {list.map((p) => (
            <li key={p.key}>
              <Link to={buildPath(p.last, '/pipelines')} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-6 py-2.5 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
                <span className="min-w-0">
                  <JobName name={p.job} />
                  {p.applications.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{p.applications.join(', ')}</span>}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ResultBadge result={p.last.result} />
                  {since(p.last.startedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  )
}

// ---- Your requests ---------------------------------------------------------

export function RequestsCard() {
  const mine = useMine()
  const open = mine.data?.filter((r) => isInFlight(r.status)).length ?? 0
  return (
    <CardFrame
      info={{ ...CARDS.requests, description: mine.data && open > 0 ? `${open} still in progress. Newest first.` : CARDS.requests.description }}
      flush
      action={(mine.data?.length ?? 0) > 0 && <MoreLink to="/requests" label="All requests" />}
    >
      {!mine.data ? (
        <div className="px-6 pb-4">
          {mine.error ? (
            <p className="text-sm text-muted-foreground">{mine.error}</p>
          ) : (
            <Loading label="Loading your requests…">
              <RowsSkeleton bordered={false} />
            </Loading>
          )}
        </div>
      ) : mine.data.length === 0 ? (
        <Empty className="rounded-none border-t border-solid py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>You haven’t asked for anything yet</EmptyTitle>
            <EmptyDescription>Ask DevOps for a repository, a project or access, and follow it here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  <Plus /> New request <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <NewRequestMenuContent align="center" />
            </DropdownMenu>
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="divide-y border-t">
          {mine.data.slice(0, 5).map((request) => (
            <li key={request.id}>
              <RequestRow request={request} />
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  )
}

// ---- Your teams' projects --------------------------------------------------

export function ProjectsCard({ profile }: { profile: Profile | undefined }) {
  const { status, systems, scope } = useCatalog()
  const groups = new Set((profile?.groups ?? []).map((g) => g.toLowerCase()))
  // Most people's catalog is already their teams' projects (the API scopes it). Someone who sees
  // every project gets the ones whose team fields (dev_team, qc_team…) name a group they are in.
  const yours = (scope && !scope.all ? systems : systems.filter((s) => Object.values(s.teams ?? {}).some((team) => typeof team === 'string' && groups.has(team.toLowerCase()))))
    .slice()
    .sort((a, b) => (a.projectName ?? '').localeCompare(b.projectName ?? ''))
  return (
    <CardFrame info={CARDS.projects} flush action={<MoreLink to="/map" label="Map" />}>
      {status === 'loading' ? (
        <div className="px-6 pb-4">
          <RowsSkeleton rows={3} bordered={false} />
        </div>
      ) : yours.length === 0 ? (
        <p className="flex items-start gap-2 border-t px-6 py-6 text-sm text-muted-foreground">
          <Users className="mt-0.5 size-4 shrink-0" aria-hidden />
          {/* One span: as loose flex children the words broke into columns on a phone. */}
          <span>No project lists one of your teams as an owner yet.</span>
        </p>
      ) : (
        <ul className="divide-y border-t">
          {yours.slice(0, 8).map((s) => (
            <li key={s.id}>
              <Link to={`/map?q=${encodeURIComponent(s.projectName ?? s.id)}`} className="flex items-center justify-between gap-3 px-6 py-2.5 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
                <span className="min-w-0 truncate font-mono text-xs">{s.projectName ?? s.id}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {s.applications.length} {s.applications.length === 1 ? 'application' : 'applications'}
                </span>
              </Link>
            </li>
          ))}
          {yours.length > 8 && <li className="px-6 py-2 text-xs text-muted-foreground">and {yours.length - 8} more on the map</li>}
        </ul>
      )}
    </CardFrame>
  )
}

// ---- The catalog ------------------------------------------------------------

export function CatalogCard() {
  const navigate = useNavigate()
  const { status, systems, sync, error } = useCatalog()
  const stats = useMemo(() => {
    const byTechnology = new Map<string, number>()
    const bySystem = new Map<string, number>()
    let applications = 0
    for (const system of systems) {
      // A system missing its name in the inventories still counts, under its id.
      const name = system.projectName || system.id
      bySystem.set(name, (bySystem.get(name) ?? 0) + system.applications.length)
      for (const app of system.applications) {
        applications++
        const tech = app.buildTechnology || 'Not set'
        byTechnology.set(tech, (byTechnology.get(tech) ?? 0) + 1)
      }
    }
    return { applications, technologies: topWithOther(byTechnology, 8), largest: topWithOther(bySystem, 8).filter((row) => row.name !== 'Other') }
  }, [systems])
  return (
    <CardFrame
      info={{ ...CARDS.catalog, description: sync?.finishedAt ? `${systems.length} systems, ${stats.applications} applications — updated ${since(sync.finishedAt)}.` : CARDS.catalog.description }}
      action={<MoreLink to="/map" label="Map" />}
    >
      {status === 'error' ? (
        <p className="text-sm text-muted-foreground">The projects can’t be read right now: {error}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Boxes className="size-3.5" aria-hidden /> Applications by technology
            </p>
            {status === 'loading' ? <BarsSkeleton /> : <Suspense fallback={<BarsSkeleton />}><RankedBars data={stats.technologies} label="Applications by technology" /></Suspense>}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Largest systems — select one to open it on the map</p>
            {status === 'loading' ? (
              <BarsSkeleton />
            ) : (
              <Suspense fallback={<BarsSkeleton />}>
                <RankedBars data={stats.largest} label="Largest systems" onSelect={(name) => navigate(`/map?q=${encodeURIComponent(name)}`)} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </CardFrame>
  )
}
