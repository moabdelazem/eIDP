import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { FileWarning } from 'lucide-react'
import { PageHeader } from '@/components/page-layout.tsx'
import { HeaderSkeleton, Loading } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import type { Environment } from './catalog.ts'
import { useCatalog } from './catalog-context.tsx'
import { CatalogUnavailable } from './catalog-error.tsx'
import { MapList } from './map-list.tsx'
import { MapPanel } from './map-panel.tsx'
import { MapToolbar } from './map-toolbar.tsx'
import { RefreshCatalogButton } from './refresh-catalog-button.tsx'
import { NoProjects, ScopeNote } from './scope-note.tsx'
import { allBranchIds, buildTree, ENV_ORDER, facetsOf, filterSystems, hasFilters, pathTo, resolve, type Filters } from './tree.ts'

// React Flow is most of the canvas's weight; a phone that opens on the list never loads it.
const FlowMap = lazy(() => import('./flow-map.tsx').then((module) => ({ default: module.FlowMap })))

/**
 * The projects map: every system the reader may see, its applications, and
 * where they run — as a map to explore or a list to scan, with a panel that
 * answers "who owns it, where does it run" for whatever is chosen.
 *
 * Its whole state lives in the URL — search (`q`), technologies (`tech`),
 * environments (`env`), the view and the chosen card (`sel`) — so a link
 * lands on exactly this, and back and forward step through it. Which
 * branches are open is not: it follows from the filters and the choice.
 */
export function ProjectMapPage() {
  usePageTitle('Projects map')
  const { status, systems, sync, scope, error, reload } = useCatalog()
  const { can } = useProfile()
  const [params, setParams] = useSearchParams()

  const filters = useMemo(() => readFilters(params), [params])
  const selected = params.get('sel')
  // A tree needs width a phone does not have; the list reads fine there.
  const view: 'map' | 'list' = params.get('view') === 'list' || params.get('view') === 'map' ? (params.get('view') as 'map' | 'list') : window.matchMedia('(max-width: 767px)').matches ? 'list' : 'map'

  // Name the root after the company when every system agrees on one.
  const rootLabel = useMemo(() => {
    const company = systems[0]?.company
    return company && systems.every((system) => system.company === company) ? company : 'Organization'
  }, [systems])
  const root = useMemo(() => buildTree(systems, rootLabel, filters), [systems, rootLabel, filters])
  const kept = useMemo(() => filterSystems(systems, filters), [systems, filters])
  const facets = useMemo(() => facetsOf(systems), [systems])
  const total = useMemo(() => ({ systems: systems.length, applications: systems.reduce((n, s) => n + s.applications.length, 0) }), [systems])
  const showing = { systems: kept.length, applications: kept.reduce((n, k) => n + k.apps.length, 0) }

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']))
  const [focusKey, setFocusKey] = useState(0)
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setWide(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const update = useCallback(
    (change: (next: URLSearchParams) => void) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          change(next)
          return next
        },
        // Typing and choosing replace the entry: the history is for places, not keystrokes.
        { replace: true },
      ),
    [setParams],
  )

  /**
   * A narrowed tree opens down to the applications: you filtered to see what
   * matched. Clearing returns to the top level rather than leaving hundreds
   * open. The filter and the expansion land in one update, so the map
   * measures the tree it will actually draw.
   */
  const applyFilters = useCallback(
    (next: Filters) => {
      const nextRoot = buildTree(systems, rootLabel, next)
      setExpanded(hasFilters(next) ? new Set(allBranchIds(nextRoot, 1)) : new Set(['root']))
      update((p) => writeFilters(p, next))
    },
    [systems, rootLabel, update],
  )

  const select = useCallback(
    (id: string | null) => {
      if (id) setExpanded((current) => withPath(current, root, id))
      update((p) => (id ? p.set('sel', id) : p.delete('sel')))
    },
    [root, update],
  )

  // A link that arrives filtered or with a card chosen opens down to it once the catalog is here, and centres it.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || systems.length === 0) return
    seeded.current = true
    let open = hasFilters(filters) ? new Set(allBranchIds(root, 1)) : new Set(['root'])
    if (selected) {
      open = withPath(open, root, selected)
      setFocusKey((k) => k + 1)
    }
    setExpanded(open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systems])

  // Escape lets go of the chosen card.
  useEffect(() => {
    if (!selected) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target as HTMLElement).closest('input, [role=dialog]')) select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, select])

  if (status === 'error') return <CatalogUnavailable error={error!} onRetry={reload} />
  if (status === 'loading') return <MapSkeleton />
  if (systems.length === 0) {
    return (
      <div>
        <PageHeader title="Projects map" actions={<RefreshCatalogButton />} />
        <div className="mt-6">
          <NoProjects />
        </div>
      </div>
    )
  }

  const chosen = resolve(systems, selected)
  const panel = (
    <MapPanel
      systems={systems}
      selected={chosen ? selected : null}
      facets={facets}
      filters={filters}
      onSelect={select}
      onFilter={applyFilters}
      onLocate={view === 'map' ? () => setFocusKey((k) => k + 1) : undefined}
    />
  )
  const devops = can('catalog.sync')

  return (
    <div>
      <PageHeader
        title="Projects map"
        description={
          <>
            Every system{scope && !scope.all ? ' your teams own' : ''}, its applications and where they run.
            {sync?.finishedAt && (
              <span className="text-muted-foreground/80">
                {' '}
                Updated {since(sync.finishedAt)}
                {devops && sync.commit ? (
                  <>
                    {' '}
                    from <code>inventories</code> at {sync.commit.slice(0, 8)}
                  </>
                ) : null}
                .
              </span>
            )}
          </>
        }
        actions={
          <>
            {/* Files a sync skipped are DevOps's to fix, so only those who sync see them. */}
            {devops && sync && sync.warnings.length > 0 && <SkippedFiles files={sync.warnings} />}
            <RefreshCatalogButton />
          </>
        }
      >
        <ScopeNote scope={scope} shown={systems.length} />
      </PageHeader>

      <div className="mt-5">
        <MapToolbar filters={filters} onChange={applyFilters} facets={facets} showing={showing} total={total} view={view} onView={(next) => update((p) => p.set('view', next))} />
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {view === 'map' ? (
            <div className="h-[calc(100dvh-17rem)] min-h-[30rem] overflow-hidden rounded-xl border bg-card shadow-xs">
              <Suspense fallback={<Skeleton className="h-full w-full rounded-none" />}>
                <FlowMap
                  root={root}
                  expanded={expanded}
                  selected={chosen ? selected : null}
                  query={filters.query}
                  fitKey={`${filters.query}|${filters.technologies}|${filters.environments}`}
                  focusKey={focusKey}
                  onToggle={(id) => setExpanded((current) => toggled(current, id))}
                  onSelect={select}
                  onExpandAll={() => setExpanded(new Set(allBranchIds(root)))}
                  onCollapseAll={() => setExpanded(new Set(['root']))}
                />
              </Suspense>
            </div>
          ) : (
            <MapList systems={kept} query={filters.query} selected={chosen ? selected : null} onSelect={select} onClear={() => applyFilters({ query: '', technologies: [], environments: [] })} />
          )}
        </div>

        {/* The panel sits beside the map on a wide screen and rises from the bottom on a narrow one, only when something is chosen. */}
        {wide ? (
          <aside aria-label="Details" className={`sticky top-4 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-xl border bg-card shadow-xs ${view === 'map' ? 'lg:max-h-[calc(100dvh-17rem)] lg:min-h-[30rem]' : ''}`}>
            {panel}
          </aside>
        ) : (
          <Sheet open={Boolean(chosen)} onOpenChange={(open) => !open && select(null)}>
            <SheetContent side="bottom" showCloseButton={false} className="max-h-[85dvh] overflow-y-auto rounded-t-xl p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{chosen?.app?.name ?? chosen?.system.projectName ?? 'Details'}</SheetTitle>
                <SheetDescription>Who owns it and where it runs.</SheetDescription>
              </SheetHeader>
              {panel}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </div>
  )
}

function readFilters(params: URLSearchParams): Filters {
  const list = (key: string) => (params.get(key) ?? '').split(',').filter(Boolean)
  return {
    query: params.get('q') ?? '',
    technologies: list('tech'),
    // Only environments this build knows: a link from elsewhere cannot filter on a typo.
    environments: list('env').filter((env): env is Environment => (ENV_ORDER as string[]).includes(env)),
  }
}

function writeFilters(params: URLSearchParams, filters: Filters) {
  const set = (key: string, value: string) => (value ? params.set(key, value) : params.delete(key))
  set('q', filters.query)
  set('tech', filters.technologies.join(','))
  set('env', filters.environments.join(','))
}

function toggled(current: Set<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** The open branches plus every one on the way to `id`, so what is chosen is on screen. */
function withPath(current: Set<string>, root: Parameters<typeof pathTo>[0], id: string): Set<string> {
  const path = pathTo(root, id)
  if (!path) return current
  const next = new Set(current)
  for (const step of path.slice(0, -1)) next.add(step)
  return next
}

function MapSkeleton() {
  return (
    <Loading label="Loading the projects map…">
      <HeaderSkeleton />
      <div className="mt-6 flex gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="h-[28rem] w-full rounded-xl" />
        <Skeleton className="hidden h-[28rem] w-full rounded-xl lg:block" />
      </div>
    </Loading>
  )
}

/**
 * The files the last sync could not read: a button that says how many, with
 * the list in a dialog — a sync can skip dozens, and the map should not
 * scroll past them. Red: a DevOps engineer has YAML to fix.
 */
function SkippedFiles({ files }: { files: string[] }) {
  const n = files.length
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive">
          <FileWarning /> {n} skipped file{n === 1 ? '' : 's'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Skipped by the last sync</DialogTitle>
          <DialogDescription>
            These files in <code>inventories</code> could not be read, so the map is built without them. Fix the YAML and the next sync picks them up.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y rounded-md border font-mono text-xs">
          {files.map((file) => (
            <li key={file} className="px-3 py-2 break-words">
              {file}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
