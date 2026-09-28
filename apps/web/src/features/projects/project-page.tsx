import { Check, Minus } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { EmptyState } from '@/components/empty-state.tsx'
import { Skeleton } from '@/components/ui/skeleton'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { fetchApplication, type ApplicationConfig } from './api.ts'
import { findApplication, type Environment } from './catalog.ts'
import { differences, keySettings } from './config.ts'
import { DataView } from '@/components/data-view.tsx'
import { useCatalog } from './catalog-context.tsx'
import { CatalogUnavailable } from './catalog-error.tsx'

/** The environments every system is described against, in promotion order. */
const PROMOTION: Environment[] = ['dev', 'qc', 'uat', 'prd']

export function ProjectPage() {
  const { status, systems, error, reload } = useCatalog()
  const found = findApplication(systems, useParams().projectId)
  usePageTitle(found?.app.name ?? 'Application')
  // The full configuration is fetched per page rather than shipped with the
  // whole catalog: 1100 descriptors on every map load would be waste.
  const config = useResource(
    () => (found ? fetchApplication(found.system.id, found.app.name) : Promise.resolve([])),
    [found?.system.id, found?.app.name],
  )

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
  // Until the configuration loads, assume the common case: a base exists.
  const hasBase = config.data ? config.data.some((row) => row.environment === null) : true
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

      <Configuration rows={config.data} error={config.error} />

      <section className="mt-10">
        <h2 className="text-sm font-medium">Environments and who owns them</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Teams are set once per system, in <code>{system.id}/group_vars/all/project.yml</code>.
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
              const state = environmentState(env, app.environments, hasBase)
              return (
                <tr key={env} className={state === 'missing' ? 'text-muted-foreground' : ''}>
                  <td className="w-20 py-2.5 font-mono">{env}</td>
                  <td className="w-44 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      {state === 'missing' ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}
                      {state === 'override' ? 'Own override' : state === 'base' ? 'Uses the base' : 'Not configured'}
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

/**
 * How an environment gets its configuration.
 *
 * Systems use two conventions. Some (NBFS) give an environment its own
 * `prd_<app>` group; others (AgriLand) have one group shared by every
 * environment. A missing override is therefore not "not configured" — it
 * means the environment runs the base. Only an app with no base at all is
 * genuinely unconfigured where it has no group.
 */
function environmentState(
  env: Environment,
  overrides: Environment[],
  hasBase: boolean,
): 'override' | 'base' | 'missing' {
  if (overrides.includes(env)) return 'override'
  return hasBase ? 'base' : 'missing'
}

/**
 * What the application runs with: the settings people come for, what each
 * environment changes, and everything else from its group_vars files.
 */
function Configuration({ rows, error }: { rows: ApplicationConfig[] | undefined; error: string | null }) {
  if (error && !rows) {
    return <p className="mt-10 text-sm text-destructive">Could not load the configuration: {error}</p>
  }
  if (!rows) return <Skeleton className="mt-10 h-48 w-full" />
  if (rows.length === 0) return null

  // The unprefixed group is the base; an app defined only per environment has
  // none, and then its first environment stands in.
  const base = rows.find((row) => row.environment === null) ?? rows[0]!
  const settings = keySettings(base.descriptor)
  const overrides = rows
    .filter((row) => row !== base && row.environment)
    .map((row) => ({ environment: row.environment!, changes: differences(base.descriptor, row.descriptor) }))

  return (
    <>
      <section className="mt-10">
        <h2 className="text-sm font-medium">Runtime</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          From <code>cicd.yml</code> and the technology file beside it, merged in the order Ansible
          applies them
          {base.environment && (
            <>
              {' '}— shown for <code>{base.environment}</code>, as there is no base configuration
            </>
          )}
          .
        </p>
        {settings.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            None of the usual runtime settings are set; everything the files hold is listed below.
          </p>
        ) : (
          <dl className="mt-3 grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2.5 text-sm">
            {settings.map((setting) => (
              <div key={setting.label} className="contents">
                <dt className="text-muted-foreground">{setting.label}</dt>
                <dd>
                  <code>{setting.value}</code>
                  {setting.hint && <span className="ml-2 text-xs text-muted-foreground">{setting.hint}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {overrides.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium">What each environment changes</h2>
          <ul className="mt-3 space-y-3 text-sm">
            {overrides.map(({ environment, changes }) => (
              <li key={environment} className="rounded-lg border bg-card p-4">
                <p className="font-mono font-medium">{environment}</p>
                {changes.length === 0 ? (
                  <p className="mt-1 text-muted-foreground">Same as the base configuration.</p>
                ) : (
                  <table className="mt-2 w-full">
                    <tbody>
                      {changes.map((change) => (
                        <tr key={change.key} className="align-top">
                          <td className="py-1 pr-4 font-mono text-muted-foreground">{change.key}</td>
                          <td className="py-1 font-mono">
                            {change.base !== null && (
                              <>
                                <span className="text-muted-foreground line-through">{change.base || '—'}</span>{' '}
                                →{' '}
                              </>
                            )}
                            {change.value || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-medium">All settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each group directory, keyed as it is in <code>inventories</code>, with its files merged.
          Passwords, tokens and vault-encrypted values show as <code>[hidden]</code>.
        </p>
        <DataView
          className="mt-3"
          // Keyed by directory, so it reads like the repo: the base group and
          // each environment's own, side by side.
          data={Object.fromEntries(rows.map((row) => [row.group, row.descriptor]))}
          filename={base.name}
        />
      </section>
    </>
  )
}
