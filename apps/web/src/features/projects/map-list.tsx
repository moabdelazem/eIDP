import { ChevronRight, Plus } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { SearchX } from 'lucide-react'
import type { Application, System } from './catalog.ts'
import { EnvPills, Highlight, TechTag } from './map-parts.tsx'
import { appId, countLabel, systemId } from './tree.ts'

/**
 * The same catalog as the map, as a list: a card per system, a row per
 * application. Phones open on it, and it is the plain path for a screen
 * reader. Choosing a row opens it in the panel, as a card on the map does;
 * the application's own page is a click further, from the panel or the
 * row's arrow.
 */
export function MapList({
  systems,
  query,
  selected,
  onSelect,
  onClear,
}: {
  systems: { system: System; apps: Application[] }[]
  query: string
  selected: string | null
  onSelect: (id: string) => void
  onClear: () => void
}) {
  if (systems.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>Nothing matches</EmptyTitle>
          <EmptyDescription>No system or application fits those filters.</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={onClear}>
          Clear the filters
        </Button>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {systems.map(({ system, apps }) => (
        <section key={system.id} aria-labelledby={`sys-${system.id}`} className="overflow-hidden rounded-xl border border-l-[3px] border-l-[var(--chart-1)] bg-card shadow-xs">
          <header className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3', selected === systemId(system) && 'bg-secondary/50')}>
            <button type="button" onClick={() => onSelect(systemId(system))} className="min-w-0 text-left focus-visible:underline focus-visible:outline-none">
              <h2 id={`sys-${system.id}`} className="truncate font-semibold">
                <Highlight text={system.projectName} query={query} />
              </h2>
              <p className="text-xs text-muted-foreground">
                {apps.length === system.applications.length ? countLabel(apps.length, 'application') : `${apps.length} of ${countLabel(system.applications.length, 'application')}`}
                {system.company && ` · ${system.company}`}
              </p>
            </button>
            {/* The old portal's ➕: a pipeline for one of the project's repositories, the project filled in. */}
            <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
              <Link to={`/requests/new/jenkins/pipeline?${new URLSearchParams({ project: system.projectName })}`}>
                <Plus /> Add an application
              </Link>
            </Button>
          </header>
          {apps.length > 0 && (
            <ul className="divide-y border-t">
              {apps.map((app) => {
                const id = appId(system, app)
                return (
                  <li key={app.id} className={cn('@container flex items-center', selected === id && 'bg-secondary/50')}>
                    <button
                      type="button"
                      onClick={() => onSelect(id)}
                      aria-pressed={selected === id}
                      className="grid min-w-0 flex-1 grid-cols-1 gap-1.5 px-4 py-2.5 text-left hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none @lg:grid-cols-[minmax(0,1fr)_8rem_minmax(0,12rem)] @lg:items-center @lg:gap-4"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          <Highlight text={app.name} query={query} />
                        </span>
                        {app.repository && (
                          <code className="block truncate text-xs text-muted-foreground">
                            <Highlight text={app.repository} query={query} />
                          </code>
                        )}
                      </span>
                      <span>
                        <TechTag technology={app.buildTechnology} />
                      </span>
                      <EnvPills environments={app.environments} size="xs" />
                    </button>
                    <Link
                      to={`/projects/${encodeURIComponent(app.id)}`}
                      className="mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                      aria-label={`Open ${app.name}`}
                    >
                      <ChevronRight className="size-4" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}
