import { toast } from 'sonner'
import { ArrowLeft, Boxes, Copy, ExternalLink, KeyRound, LocateFixed, MousePointerClick, Plus, Workflow, X } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useProfile } from '@/features/auth/profile-context.tsx'
import type { Application, Environment, System } from './catalog.ts'
import { EnvPills, TechTag } from './map-parts.tsx'
import { appId, countLabel, envLabel, inOrder, isProduction, resolve, systemId, type Filters } from './tree.ts'

/**
 * The panel beside the map: what is chosen, so a click answers "who owns it
 * and where does it run" without leaving the page — and with nothing chosen,
 * what the map holds, each line a filter.
 *
 * Everything here is from the catalog already loaded; the application's own
 * page has its full configuration.
 */

type Facets = { technologies: { name: string; count: number }[]; environments: { name: Environment; count: number }[] }

type Props = {
  systems: System[]
  selected: string | null
  facets: Facets
  filters: Filters
  onSelect: (id: string | null) => void
  onFilter: (filters: Filters) => void
  /** Centre the chosen card on the map; absent in the list view. */
  onLocate?: () => void
}

export function MapPanel({ systems, selected, facets, filters, onSelect, onFilter, onLocate }: Props) {
  const chosen = resolve(systems, selected)
  if (chosen?.app) return <AppPanel system={chosen.system} app={chosen.app} onSelect={onSelect} onLocate={onLocate} />
  if (chosen) return <SystemPanel system={chosen.system} onSelect={onSelect} onFilter={onFilter} filters={filters} onLocate={onLocate} />
  return <Summary systems={systems} facets={facets} filters={filters} onFilter={onFilter} />
}

function Shell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-5 p-5', className)}>{children}</div>
}

function Heading({ kind, title, onClose, mono = false }: { kind: string; title: string; onClose: () => void; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{kind}</p>
        <h2 className={cn('mt-0.5 text-lg leading-tight font-semibold break-words', mono ? 'font-mono text-base' : 'font-display')}>{title}</h2>
      </div>
      <Button size="icon" variant="ghost" className="-mt-1 -mr-2 size-8 shrink-0" onClick={onClose} aria-label="Close the panel">
        <X />
      </Button>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** Each environment and the team that owns it there — the question most people open the map to answer. */
function Owners({ system, environments }: { system: System; environments?: string[] }) {
  const envs = inOrder(environments ?? Object.keys(system.teams))
  if (envs.length === 0) return <p className="text-sm text-muted-foreground">No owning team is recorded for this project.</p>
  return (
    <ul className="divide-y rounded-lg border">
      {envs.map((env) => (
        <li key={env} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            {isProduction(env) ? <span aria-hidden className="size-1.5 rounded-full bg-[var(--chart-1)]" /> : <span aria-hidden className="size-1.5" />}
            <span className="font-medium">{envLabel(env)}</span>
          </span>
          <span className={cn('truncate text-right', system.teams[env] ? '' : 'text-muted-foreground')}>{system.teams[env] ?? 'No team set'}</span>
        </li>
      ))}
    </ul>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>
}

// ---- an application ----------------------------------------------------------

function AppPanel({ system, app, onSelect, onLocate }: { system: System; app: Application; onSelect: (id: string | null) => void; onLocate?: () => void }) {
  const { can } = useProfile()
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied the repository name.')
    } catch {
      toast.error('Could not copy. Select it and copy instead.')
    }
  }
  return (
    <Shell>
      <Heading kind="Application" title={app.name} onClose={() => onSelect(null)} />
      <button type="button" onClick={() => onSelect(systemId(system))} className="-mt-3 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden /> In {system.projectName}
      </button>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to={`/projects/${encodeURIComponent(app.id)}`}>
            <ExternalLink /> Open the application
          </Link>
        </Button>
        {onLocate && (
          <Button size="sm" variant="outline" onClick={onLocate}>
            <LocateFixed /> Show on map
          </Button>
        )}
      </div>

      <dl className="divide-y">
        <Row label="Repository">
          {app.repository ? (
            <span className="flex items-center gap-1">
              <code className="truncate text-[13px]">{app.repository}</code>
              <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => void copy(app.repository!)} aria-label="Copy the repository name">
                <Copy />
              </Button>
            </span>
          ) : (
            <span className="text-muted-foreground">Not recorded</span>
          )}
        </Row>
        <Row label="Built with">{app.buildTechnology ? <TechTag technology={app.buildTechnology} /> : <span className="text-muted-foreground">Not recorded</span>}</Row>
        <Row label="Deploys to">{app.deployPlatform ?? <span className="text-muted-foreground">Not recorded</span>}</Row>
        <Row label="Shape">{app.microservice === null ? <span className="text-muted-foreground">Not recorded</span> : app.microservice ? 'A microservice' : 'An application'}</Row>
      </dl>

      <div className="flex flex-col gap-2">
        <SectionTitle>Where it runs, and who owns it there</SectionTitle>
        {app.environments.length ? <Owners system={system} environments={app.environments} /> : <p className="text-sm text-muted-foreground">It has no environments yet.</p>}
      </div>

      <Separator />
      <div className="flex flex-col gap-2">
        <SectionTitle>Do something with it</SectionTitle>
        <div className="flex flex-col items-start gap-1">
          {can('pipelines.view') && (
            <Button asChild size="sm" variant="ghost" className="-ml-2 h-auto min-h-8 py-1.5 text-left whitespace-normal">
              <Link to={`/pipelines?${new URLSearchParams({ q: app.name })}`}>
                <Workflow /> Its builds
              </Link>
            </Button>
          )}
          <Button asChild size="sm" variant="ghost" className="-ml-2 h-auto min-h-8 py-1.5 text-left whitespace-normal">
            <Link to={`/requests/new/azure-devops/access?${new URLSearchParams({ project: system.projectName })}`}>
              <KeyRound /> Ask for access to {system.projectName}
            </Link>
          </Button>
        </div>
      </div>
    </Shell>
  )
}

// ---- a system ----------------------------------------------------------------

function SystemPanel({
  system,
  filters,
  onSelect,
  onFilter,
  onLocate,
}: {
  system: System
  filters: Filters
  onSelect: (id: string | null) => void
  onFilter: (filters: Filters) => void
  onLocate?: () => void
}) {
  const technologies = [...new Set(system.applications.map((a) => a.buildTechnology).filter((t): t is string => Boolean(t)))].sort()
  const inProduction = system.applications.filter((a) => a.environments.some(isProduction)).length
  return (
    <Shell>
      <Heading kind={system.company ? `System at ${system.company}` : 'System'} title={system.projectName} onClose={() => onSelect(null)} />

      <div className="grid grid-cols-3 divide-x rounded-lg border text-center">
        <Fact n={system.applications.length} label={system.applications.length === 1 ? 'application' : 'applications'} />
        <Fact n={technologies.length} label={technologies.length === 1 ? 'technology' : 'technologies'} />
        <Fact n={inProduction} label="in production" />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to={`/requests/new/jenkins/pipeline?${new URLSearchParams({ project: system.projectName })}`}>
            <Plus /> Add an application
          </Link>
        </Button>
        {onLocate && (
          <Button size="sm" variant="outline" onClick={onLocate}>
            <LocateFixed /> Show on map
          </Button>
        )}
        {filters.query.trim().toLowerCase() !== system.projectName.toLowerCase() && (
          <Button size="sm" variant="outline" onClick={() => onFilter({ query: system.projectName, technologies: [], environments: [] })}>
            Only this system
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Who owns it, by environment</SectionTitle>
        <Owners system={system} />
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Applications</SectionTitle>
        {system.applications.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet. Add the first one with a pipeline request.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {[...system.applications]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((app) => (
                <li key={app.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(appId(system, app))}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="min-w-0 truncate">{app.name}</span>
                    {app.environments.some(isProduction) && <EnvPills environments={app.environments.filter(isProduction)} size="xs" className="shrink-0" />}
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      <Separator />
      <Button asChild size="sm" variant="ghost" className="-ml-2 h-auto min-h-8 self-start py-1.5 text-left whitespace-normal">
        <Link to={`/requests/new/azure-devops/access?${new URLSearchParams({ project: system.projectName })}`}>
          <KeyRound /> Ask for access to {system.projectName}
        </Link>
      </Button>
    </Shell>
  )
}

function Fact({ n, label }: { n: number; label: string }) {
  return (
    <div className="px-2 py-2.5">
      <div className="text-lg font-semibold tabular-nums">{n}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

// ---- nothing chosen ----------------------------------------------------------

/**
 * What the map holds: how it is built and where it runs, each line a filter
 * — the bars are the share of applications, in the chart colour.
 */
function Summary({ systems, facets, filters, onFilter }: { systems: System[]; facets: Facets; filters: Filters; onFilter: (filters: Filters) => void }) {
  const apps = systems.reduce((n, s) => n + s.applications.length, 0)
  const toggle = <K extends 'technologies' | 'environments'>(key: K, value: Filters[K][number]) => {
    const list = filters[key] as string[]
    onFilter({ ...filters, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] })
  }
  return (
    <Shell>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-secondary/60 text-[var(--chart-1)]">
          <MousePointerClick className="size-4" aria-hidden />
        </span>
        <p className="text-sm text-muted-foreground">Choose a system or an application to see who owns it, where it runs, and what you can do with it.</p>
      </div>

      <div className="grid grid-cols-2 divide-x rounded-lg border text-center">
        <Fact n={systems.length} label={systems.length === 1 ? 'system' : 'systems'} />
        <Fact n={apps} label={apps === 1 ? 'application' : 'applications'} />
      </div>

      {facets.technologies.length > 0 && (
        <Breakdown
          title="Built with"
          rows={facets.technologies.slice(0, 8).map((t) => ({ key: t.name, label: t.name, count: t.count, on: filters.technologies.includes(t.name) }))}
          total={apps}
          onPick={(key) => toggle('technologies', key)}
        />
      )}
      {facets.environments.length > 0 && (
        <Breakdown
          title="Runs in"
          rows={facets.environments.map((e) => ({ key: e.name, label: envLabel(e.name), count: e.count, on: filters.environments.includes(e.name) }))}
          total={apps}
          onPick={(key) => toggle('environments', key as Environment)}
        />
      )}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Boxes className="size-3.5" aria-hidden /> {countLabel(systems.length, 'system')} from inventories.
      </p>
    </Shell>
  )
}

function Breakdown({ title, rows, total, onPick }: { title: string; rows: { key: string; label: string; count: number; on: boolean }[]; total: number; onPick: (key: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionTitle>{title}</SectionTitle>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              aria-pressed={row.on}
              onClick={() => onPick(row.key)}
              className={cn(
                'grid w-full grid-cols-[minmax(0,7rem)_minmax(0,1fr)_2rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                row.on && 'bg-secondary',
              )}
            >
              <span className="truncate">{row.label}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
                <span className="block h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${total ? Math.max(4, (row.count / total) * 100) : 0}%` }} />
              </span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">{row.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
