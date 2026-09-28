import { lazy, Suspense, useMemo } from 'react'
import { ArrowRight, ChevronDown, Inbox, Plus, TriangleAlert } from 'lucide-react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useCatalog } from '@/features/projects/catalog-context.tsx'
import { isInFlight, requestsApi } from '@/features/requests/api.ts'
import { NewRequestMenuContent } from '@/features/requests/new-request-menu.tsx'
import { RequestRow } from '@/features/requests/request-row.tsx'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import type { Datum } from './charts.tsx'
import { BarsSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'

// Recharts is most of the weight of this page and none of the others, so it
// loads with the charts rather than with the app.
const RankedBars = lazy(() => import('./charts.tsx').then((module) => ({ default: module.RankedBars })))

/**
 * The home page: what exists, what you are waiting on, and — for DevOps —
 * what is waiting on them. A composition of other features, so it reads their
 * public pieces rather than owning data of its own.
 */
export function OverviewPage() {
  usePageTitle('Overview')
  const [params] = useSearchParams()
  // The map lived at / and linked there with ?q=; keep those links working.
  if (params.get('q')) return <Navigate to={`/map?${params}`} replace />
  return <Overview />
}

function Overview() {
  const navigate = useNavigate()
  const { status, systems, sync, error } = useCatalog()
  const { isApprover, profile } = useProfile()
  const mine = useResource(() => requestsApi.mine(), [], { pollMs: 30_000 })
  const pool = useResource(() => (isApprover ? requestsApi.pool() : Promise.resolve(null)), [isApprover], {
    pollMs: 30_000,
  })

  const stats = useMemo(() => {
    const byTechnology = new Map<string, number>()
    const bySystem = new Map<string, number>()
    let applications = 0
    for (const system of systems) {
      bySystem.set(system.projectName, system.applications.length)
      for (const app of system.applications) {
        applications++
        const tech = app.buildTechnology ?? 'Not set'
        byTechnology.set(tech, (byTechnology.get(tech) ?? 0) + 1)
      }
    }
    return {
      applications,
      technologies: topWithOther(byTechnology, 8),
      largest: topWithOther(bySystem, 8).filter((row) => row.name !== 'Other'),
    }
  }, [systems])

  const openRequests = mine.error ? null : mine.data?.filter((r) => isInFlight(r.status) || r.status === 'failed').length
  const waiting = pool.error ? null : pool.data?.open.filter((r) => r.status === 'pending').length
  const failed = pool.error ? null : pool.data?.open.filter((r) => r.status === 'failed').length

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
      <p className="mt-1 text-muted-foreground">
        {profile?.name ? `Signed in as ${profile.name}` : 'Signed in'}
        {sync?.finishedAt && `. The catalog was built ${since(sync.finishedAt)}.`}
      </p>

      {/* Headline counts are tiles, not charts: one number each, and every
          tile goes somewhere. */}
      <div className={`mt-6 grid gap-3 sm:grid-cols-2 ${isApprover ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        <Tile label="Systems" value={catalogCount(status, systems.length)} to="/map" />
        <Tile label="Applications" value={catalogCount(status, stats.applications)} to="/map" />
        <Tile label="Your open requests" value={openRequests} to="/requests" />
        {isApprover && (
          <Tile
            label="Waiting for a decision"
            value={waiting}
            to="/approvals"
            // The one number on the page that asks something of the reader.
            attention={(waiting ?? 0) > 0}
          />
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {status === 'error' ? (
          <Alert variant="destructive" className="lg:col-span-2">
            <TriangleAlert />
            <AlertTitle>Can’t reach the projects right now</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <>
            <ChartCard title="Applications by technology" description="From each application’s build_technology.">
              {status === 'loading' ? <BarsSkeleton /> : <RankedBars data={stats.technologies} label="Applications by technology" />}
            </ChartCard>
            <ChartCard title="Largest systems" description="By number of applications. Select one to open it on the map.">
              {status === 'loading' ? (
                <BarsSkeleton />
              ) : (
                <RankedBars
                  data={stats.largest}
                  label="Largest systems"
                  onSelect={(name) => navigate(`/map?q=${encodeURIComponent(name)}`)}
                />
              )}
            </ChartCard>
          </>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="gap-0 py-0">
          <CardHeader className="flex flex-row items-center justify-between py-4">
            <CardTitle className="text-sm">Your recent requests</CardTitle>
            {(mine.data?.length ?? 0) > 0 && (
              <Button asChild variant="ghost" size="sm">
                <Link to="/requests">
                  All requests <ArrowRight />
                </Link>
              </Button>
            )}
          </CardHeader>
          {!mine.data ? (
            <Loading label="Loading your requests…">
              <RowsSkeleton bordered={false} />
            </Loading>
          ) : mine.data.length === 0 ? (
            <Empty className="rounded-none border-t border-solid py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>You haven’t asked for anything yet</EmptyTitle>
                <EmptyDescription>Ask DevOps for a repository or a project and follow it here.</EmptyDescription>
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
        </Card>

        <div className="space-y-6">
          {isApprover && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">For DevOps</CardTitle>
                <CardDescription>What is waiting on the team.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Line label="Waiting for a decision" value={waiting} to="/approvals" attention={(waiting ?? 0) > 0} />
                <Line label="Failed, needs a retry" value={failed} to="/approvals" attention={(failed ?? 0) > 0} />
                <Line
                  label="Files the last sync skipped"
                  value={status === 'loading' ? undefined : (sync?.warnings.length ?? null)}
                  to="/map"
                  attention={(sync?.warnings.length ?? 0) > 0}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Catalog</CardTitle>
              <CardDescription>
                Built from <code>inventories</code>
                {sync?.commit && (
                  <>
                    {' '}at <code>{sync.commit.slice(0, 8)}</code>
                  </>
                )}
                {sync?.finishedAt ? `, ${since(sync.finishedAt)}.` : '.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Refreshes every 30 minutes from Azure DevOps. The map shows what the last successful
              build found, even if a later one failed.
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

/** A catalog count: a skeleton while loading, a dash when it cannot be built. */
function catalogCount(status: 'loading' | 'ready' | 'error', count: number): number | null | undefined {
  return status === 'ready' ? count : status === 'error' ? null : undefined
}

function Tile({
  label,
  value,
  to,
  attention = false,
}: {
  label: string
  /** undefined while loading; null when it could not be counted. */
  value: number | null | undefined
  to: string
  attention?: boolean
}) {
  return (
    <Link
      to={to}
      className="group rounded-xl border bg-card p-4 transition-colors hover:border-ring/40 hover:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      {value === undefined ? (
        <Skeleton className="mt-2 h-8 w-16" />
      ) : value === null ? (
        <p className="mt-1 text-3xl font-semibold text-muted-foreground">—</p>
      ) : (
        <p className={`mt-1 text-3xl font-semibold tabular-nums ${attention ? 'text-primary' : ''}`}>
          {value.toLocaleString()}
        </p>
      )}
    </Link>
  )
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<BarsSkeleton />}>{children}</Suspense>
      </CardContent>
    </Card>
  )
}

function Line({
  label,
  value,
  to,
  attention,
}: {
  label: string
  value: number | null | undefined
  to: string
  attention: boolean
}) {
  return (
    <Link to={to} className="-mx-2 flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50">
      <span>{label}</span>
      {value === undefined ? (
        <Skeleton className="h-4 w-6" />
      ) : value === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className={`tabular-nums font-medium ${attention ? 'text-primary' : 'text-muted-foreground'}`}>
          {value}
        </span>
      )}
    </Link>
  )
}

/**
 * The top `limit` by count, and everything past it folded into one "Other"
 * bar. A long tail gets a single bar, never more colours or more bars than
 * anyone can read.
 */
export function topWithOther(counts: Map<string, number>, limit: number): Datum[] {
  const ranked = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  if (ranked.length <= limit + 1) return ranked
  const rest = ranked.slice(limit).reduce((total, row) => total + row.count, 0)
  return [...ranked.slice(0, limit), { name: 'Other', count: rest }]
}
