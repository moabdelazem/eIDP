import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCatalog } from './catalog-context.tsx'
import { CatalogUnavailable } from './catalog-error.tsx'
import { Skeleton } from '@/components/ui/skeleton'
import { MindMap } from './mind-map.tsx'
import { buildTree, matches, pathTo } from './tree.ts'
import type { System } from './catalog.ts'

export function ProjectMapPage() {
  const { status, systems, sync, error, reload } = useCatalog()

  // Name the root after the company when every system agrees on one.
  const root = useMemo(() => {
    const company = systems[0]?.company
    const shared = company && systems.every((system) => system.company === company)
    return buildTree(systems, shared ? company : 'Organization')
  }, [systems])
  const [view, setView] = useState<'map' | 'list'>('map')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']))
  const [focusId, setFocusId] = useState<string | null>(null)

  const hits = useMemo(() => matches(root, query), [root, query])

  if (status === 'error') return <CatalogUnavailable error={error!} onRetry={reload} />
  if (status === 'loading') return <MapSkeleton />

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Opens every ancestor of a hit, then centres the map on it. */
  function reveal(id: string) {
    const path = pathTo(root, id)
    if (!path) return
    setExpanded((current) => new Set([...current, ...path.slice(0, -1)]))
    setFocusId(id)
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Project map</h1>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a system or application"
            className="w-64"
            aria-label="Find a system or application"
          />
          <div className="flex rounded-md border p-0.5">
            {(['map', 'list'] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={view === option ? 'secondary' : 'ghost'}
                onClick={() => setView(option)}
                className="capitalize"
              >
                {option}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {query && (
        <div className="mt-3 flex flex-wrap gap-2">
          {hits.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches “{query}”.</p>
          ) : (
            hits.slice(0, 12).map((hit) => (
              <Button key={hit.id} size="sm" variant="outline" onClick={() => reveal(hit.id)}>
                {hit.label}
              </Button>
            ))
          )}
        </div>
      )}

      <div className="mt-4">
        {view === 'map' ? (
          <MindMap root={root} expanded={expanded} onToggle={toggle} focusId={focusId} />
        ) : (
          <CatalogList systems={systems} />
        )}
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        {sync?.commit
          ? `Built from inventories at ${sync.commit.slice(0, 8)}${
              sync.finishedAt ? ` on ${new Date(sync.finishedAt).toLocaleString()}` : ''
            }.`
          : 'Click a filled node to open it, an application name to see its detail.'}
      </p>
    </div>
  )
}

function MapSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-4 h-96 w-full" />
    </div>
  )
}

/** The same catalog as a plain list — searchable, linkable, screen-reader friendly. */
function CatalogList({ systems }: { systems: System[] }) {
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
                    {app.buildTechnology && (
                      <Badge variant="secondary">{app.buildTechnology}</Badge>
                    )}
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
