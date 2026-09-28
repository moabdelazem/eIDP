import { Check, Minus } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { EmptyState } from '@/components/empty-state.tsx'
import { Skeleton } from '@/components/ui/skeleton'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { findApplication, type Environment } from './catalog.ts'
import { useCatalog } from './catalog-context.tsx'
import { CatalogUnavailable } from './catalog-error.tsx'

/** The environments every system is described against, in promotion order. */
const PROMOTION: Environment[] = ['dev', 'qc', 'uat', 'prd']

export function ProjectPage() {
  const { status, systems, error, reload } = useCatalog()
  const found = findApplication(systems, useParams().projectId)
  usePageTitle(found?.app.name ?? 'Application')

  if (status === 'error') return <CatalogUnavailable error={error!} onRetry={reload} />
  if (status === 'loading') return <Skeleton className="h-64 w-full max-w-2xl" />

  if (!found) {
    return (
      <EmptyState title="No such application">
        Nothing in the map has that name. It may have been renamed or removed from{' '}
        <code>inventories</code>.
      </EmptyState>
    )
  }

  const { system, app } = found
  const siblings = system.applications.filter((other) => other.id !== app.id)
  // prd_dr only matters where it exists; the four promotion stages always show,
  // so a gap — built for dev and qc, never promoted — is visible at a glance.
  const environments = app.environments.includes('prd_dr') ? [...PROMOTION, 'prd_dr' as const] : PROMOTION

  const facts: [string, React.ReactNode][] = [
    ['Repository', app.repository ? <code>{app.repository}</code> : null],
    ['Build', app.buildTechnology],
    ['Platform', app.deployPlatform],
    ['Microservice', app.microservice === null ? null : app.microservice ? 'Yes' : 'No'],
  ]

  return (
    <div className="max-w-2xl">
      <h1 className="font-mono text-lg font-semibold break-words">{app.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Application in{' '}
        <Link to={`/?q=${encodeURIComponent(system.projectName)}`} className="underline underline-offset-2">
          {system.projectName}
        </Link>
      </p>

      <dl className="mt-8 grid grid-cols-[8rem_minmax(0,1fr)] gap-y-3 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value ?? <span className="text-muted-foreground">Not set in inventories</span>}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-10">
        <h2 className="text-sm font-medium">Environments and who owns them</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The team for each environment comes from the system’s <code>project.yml</code>.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>Environment</th>
              <th>Configured in inventories</th>
              <th>Owning team</th>
            </tr>
          </thead>
          <tbody className="divide-y border-y">
            {environments.map((env) => {
              const present = app.environments.includes(env)
              return (
                <tr key={env} className={present ? '' : 'text-muted-foreground'}>
                  <td className="w-20 py-2.5 font-mono">{env}</td>
                  <td className="w-40 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      {present ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
                      {present ? 'Configured' : 'Not configured'}
                    </span>
                  </td>
                  <td className="py-2.5">{system.teams[env] ?? <span className="text-muted-foreground">No team set</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {siblings.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium">
            Also in {system.projectName} ({siblings.length})
          </h2>
          <ul className="mt-3 divide-y rounded-lg border bg-card text-sm">
            {siblings.map((other) => (
              <li key={other.id}>
                <Link
                  to={`/projects/${encodeURIComponent(other.id)}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/50"
                >
                  <span className="truncate font-mono">{other.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{other.buildTechnology}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
