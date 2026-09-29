import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { System } from './catalog.ts'
import { useCatalog } from './catalog-context.tsx'
import { CatalogUnavailable } from './catalog-error.tsx'
import { MapToolbar } from './map-toolbar.tsx'
import { MindMap } from './mind-map.tsx'
import {
  allBranchIds,
  buildTree,
  countLeaves,
  emptyFilters,
  facetsOf,
  hasFilters,
  type Filters,
} from './tree.ts'
import { PageHeader } from '@/components/page-layout.tsx'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { TriangleAlert } from 'lucide-react'
import { RefreshCatalogButton } from './refresh-catalog-button.tsx'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { HeaderSkeleton, Loading } from '@/components/skeletons.tsx'

export function ProjectMapPage() {
  usePageTitle('Projects map')
  const { status, systems, sync, error, reload } = useCatalog()
  const { can } = useProfile()
  const [searchParams, setSearchParams] = useSearchParams()
  // A tree needs width a phone does not have; the list reads fine there.
  const [view, setView] = useState<'map' | 'list'>(() =>
    window.matchMedia('(max-width: 767px)').matches ? 'list' : 'map',
  )
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']))
  const seededFromUrl = useRef(false)

  // Name the root after the company when every system agrees on one.
  const rootLabel = useMemo(() => {
    const company = systems[0]?.company
    return company && systems.every((system) => system.company === company) ? company : 'Organization'
  }, [systems])

  const root = useMemo(
    () => buildTree(systems, rootLabel, filters),
    [systems, rootLabel, filters],
  )
  const facets = useMemo(() => facetsOf(systems), [systems])

  const showing = useMemo(
    () => ({ systems: countLeaves(root, 'system'), applications: countLeaves(root, 'application') }),
    [root],
  )

  /**
   * A narrowed tree opens itself down to the applications: you filtered to see
   * what matched, so making you click through to it is busywork. Clearing the
   * filters returns to the top level rather than leaving hundreds open.
   *
   * Both happen in one update, so the map measures the tree it will actually
   * draw — done in an effect, the fit ran a render early and overflowed.
   */
  function applyFilters(next: Filters) {
    const nextRoot = buildTree(systems, rootLabel, next)
    setFilters(next)
    setExpanded(hasFilters(next) ? new Set(allBranchIds(nextRoot, 2)) : new Set(['root']))
    // The search lives in the URL, so a link to "/?q=AgriLand" lands on it and
    // back/forward keep it. `replace`, so typing does not flood the history.
    const query = next.query.trim()
    setSearchParams(query ? { q: query } : {}, { replace: true })
  }

  // Apply a ?q= from a link once the catalog is here to search. Through
  // applyFilters, so the expansion lands in the same update as the filter.
  useEffect(() => {
    if (seededFromUrl.current || systems.length === 0) return
    seededFromUrl.current = true
    const q = searchParams.get('q')
    if (q) applyFilters({ ...emptyFilters, query: q })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systems])

  if (status === 'error') return <CatalogUnavailable error={error!} onRetry={reload} />
  if (status === 'loading') return <MapSkeleton />

  const filtered = systems
    .map((system) => ({
      ...system,
      applications: system.applications.filter((app) =>
        matchesList(app.name, app.repository, filters),
      ),
    }))
    .filter(
      (system) =>
        !hasFilters(filters) ||
        system.applications.length > 0 ||
        system.projectName.toLowerCase().includes(filters.query.trim().toLowerCase()),
    )

  return (
    <div>
      <PageHeader title="Projects map" actions={<RefreshCatalogButton />} />

      <div className="mt-4">
        <MapToolbar
          filters={filters}
          onChange={applyFilters}
          facets={facets}
          showing={showing}
          view={view}
          onView={setView}
          onExpandAll={() => setExpanded(new Set(allBranchIds(root)))}
          onCollapseAll={() => setExpanded(new Set(['root']))}
        />
      </div>

      <div className="mt-4">
        {view === 'map' ? (
          <MindMap
            root={root}
            expanded={expanded}
            onToggle={toggle}
            fitKey={`${filters.query}|${filters.technologies}|${filters.environments}`}
          />
        ) : (
          <CatalogList systems={filtered} />
        )}
      </div>

      {sync?.commit && (
        <p className="mt-3 text-sm text-muted-foreground">
          Built from <code>inventories</code> at {sync.commit.slice(0, 8)}
          {sync.finishedAt && ` on ${new Date(sync.finishedAt).toLocaleString()}`}.
        </p>
      )}

      {/* Files a sync skipped are DevOps's to fix, so only those who sync see them. */}
      {can('catalog.sync') && sync && sync.warnings.length > 0 && <SkippedFiles files={sync.warnings} />}
    </div>
  )

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
}

function matchesList(name: string, repository: string | null, filters: Filters): boolean {
  const query = filters.query.trim().toLowerCase()
  if (query && !name.toLowerCase().includes(query) && !repository?.toLowerCase().includes(query)) {
    return false
  }
  return true
}

function MapSkeleton() {
  return (
    <Loading label="Loading the projects map…">
      <HeaderSkeleton />
      <div className="mt-6 flex gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="mt-4 h-[28rem] w-full rounded-lg" />
    </Loading>
  )
}

/** The same catalog as a plain list — searchable, linkable, screen-reader friendly. */
function CatalogList({ systems }: { systems: System[] }) {
  if (systems.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing matches those filters.</p>
  }

  return (
    <div className="max-w-3xl space-y-8">
      {systems.map((system) => (
        <section key={system.id}>
          <h2 className="font-medium">{system.projectName}</h2>
          <ul className="mt-2 divide-y border-y">
            {system.applications.map((app) => (
              <li key={app.id}>
                <Link
                  to={`/projects/${encodeURIComponent(app.id)}`}
                  className="flex flex-wrap items-baseline gap-3 py-3 hover:bg-muted/50"
                >
                  <span className="font-medium">{app.name}</span>
                  {app.repository && (
                    <code className="text-sm text-muted-foreground">{app.repository}</code>
                  )}
                  <span className="ml-auto flex gap-1">
                    {app.buildTechnology && <Badge variant="secondary">{app.buildTechnology}</Badge>}
                    {app.environments.map((env) => (
                      <Badge key={env} variant="outline">
                        {env}
                      </Badge>
                    ))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * The files the last sync could not read, as a one-line alert with the list in
 * a dialog — a sync can skip dozens, and the map should not scroll past them.
 */
function SkippedFiles({ files }: { files: string[] }) {
  const n = files.length
  return (
    <Alert variant="destructive" className="mt-3">
      <TriangleAlert />
      <AlertTitle>
        {n} file{n === 1 ? '' : 's'} in inventories could not be read and {n === 1 ? 'was' : 'were'} skipped
      </AlertTitle>
      <AlertDescription>
        <p>The rest of the map is built without them. Fix the YAML and the next sync picks them up.</p>
        <Dialog>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="mt-2">
              Show the file{n === 1 ? '' : 's'}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Skipped by the last sync</DialogTitle>
              <DialogDescription>
                Paths in <code>inventories</code>, with why each could not be read.
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
      </AlertDescription>
    </Alert>
  )
}
