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
import { FactsSkeleton, HeaderSkeleton, Loading } from '@/components/skeletons.tsx'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'

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
  if (status === 'loading') {
    return (
      <Loading className={PAGE}>
        <HeaderSkeleton />
        <FactsSkeleton />
      </Loading>
    )
  }

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

  const otherTeams = Object.entries(system.teams).filter(([env]) => !(environments as string[]).includes(env))

  const facts: [string, React.ReactNode][] = [
    ['System', <Link to={`/map?q=${encodeURIComponent(system.projectName)}`} className="underline underline-offset-2">{system.projectName}</Link>],
    ['Repository', app.repository ? <code>{app.repository}</code> : null],
    ['Build', app.buildTechnology],
    ['Platform', app.deployPlatform],
    ['Microservice', app.microservice === null ? null : app.microservice ? 'Yes' : 'No'],
  ]

  return (
    <div className={PAGE}>
      <PageHeader
        title={<h1 className="font-mono text-lg font-semibold break-words">{app.name}</h1>}
        description={
          <>
            Application in{' '}
            <Link to={`/map?q=${encodeURIComponent(system.projectName)}`} className="underline underline-offset-2">
              {system.projectName}
            </Link>
          </>
        }
      />

      <Split
        aside={
          <>
            <Section title="Details">
              <Facts items={facts} empty="Not set in inventories" />
            </Section>

            <Section
              title="Environments"
              description={
                <>
                  Teams are set once per system, in <code>{system.id}/group_vars/all/project.yml</code>.
                </>
              }
            >
              <table className="w-full text-sm">
                <thead className="sr-only">
                  <tr>
                    <th>Environment</th>
                    <th>Configured in inventories</th>
                    <th>Owning team</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {environments.map((env) => {
                    const state = environmentState(env, app.environments, hasBase)
                    return (
                      <tr key={env} className={`align-top ${state === 'missing' ? 'text-muted-foreground' : ''}`}>
                        <td className="w-14 py-2 font-mono">{env}</td>
                        <td className="py-2">
                          <span className="inline-flex items-center gap-1.5">
                            {state === 'missing' ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}
                            {state === 'override' ? 'Own override' : state === 'base' ? 'Uses the base' : 'Not configured'}
                          </span>
                          <span className="block text-xs text-muted-foreground">{system.teams[env] ?? 'No team set'}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {otherTeams.length > 0 && (
                // Owned stages no application group is named after — stress,
                // preprod. Listed so the page shows every owner team.yml names.
                <div className="mt-3 border-t pt-3">
                  <Facts items={otherTeams.map(([env, team]) => [env, team])} />
                </div>
              )}
            </Section>

            {siblings.length > 0 && (
              <Section title={`Also in ${system.projectName} (${siblings.length})`} flush>
                <ul className="max-h-96 divide-y overflow-y-auto text-sm">
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
              </Section>
            )}
          </>
        }
      >
        <Configuration rows={config.data} error={config.error} />
      </Split>
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
    return <p className="text-sm text-destructive">Could not load the configuration: {error}</p>
  }
  if (!rows) {
    return (
      <Loading label="Loading configuration…">
        <Skeleton className="h-4 w-20" />
        <FactsSkeleton rows={5} className="mt-4" />
      </Loading>
    )
  }
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
      <Section
        title="Runtime"
        description={
          <>
            From <code>cicd.yml</code> and the technology file beside it, merged in the order Ansible
            applies them
            {base.environment && (
              <>
                {' '}— shown for <code>{base.environment}</code>, as there is no base configuration
              </>
            )}
            .
          </>
        }
      >
        {settings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None of the usual runtime settings are set; everything the files hold is listed below.
          </p>
        ) : (
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2.5 text-sm">
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
      </Section>

      {overrides.length > 0 && (
        <Section title="What each environment changes">
          <ul className="grid gap-3 text-sm xl:grid-cols-2">
            {overrides.map(({ environment, changes }) => (
              <li key={environment} className="rounded-lg border bg-muted/30 p-4">
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
        </Section>
      )}

      <Section
        title="All settings"
        description={
          <>
            Each group directory, keyed as it is in <code>inventories</code>, with its files merged.
            Passwords, tokens and vault-encrypted values show as <code>[hidden]</code>.
          </>
        }
      >
        <DataView
          // Keyed by directory, so it reads like the repo: the base group and
          // each environment's own, side by side.
          data={Object.fromEntries(rows.map((row) => [row.group, row.descriptor]))}
          filename={base.name}
        />
      </Section>
    </>
  )
}
