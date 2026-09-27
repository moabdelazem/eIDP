import { useMemo, useState } from 'react'
import { Link } from 'react-router'
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

export function ProjectMapPage() {
  const { status, systems, sync, error, reload } = useCatalog()
  const [view, setView] = useState<'map' | 'list'>('map')
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']))

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
  }

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
      <h1 className="text-lg font-semibold tracking-tight">Project map</h1>

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
    <div>
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-4 h-10 w-full" />
      <Skeleton className="mt-4 h-96 w-full" />
    </div>
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
