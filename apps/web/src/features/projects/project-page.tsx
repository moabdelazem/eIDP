import { useParams } from 'react-router'
import { EmptyState } from '@/components/empty-state.tsx'
import { Badge } from '@/components/ui/badge'
import { findApplication } from './catalog.ts'
import { useCatalog } from './catalog-context.tsx'
import { CatalogUnavailable } from './catalog-error.tsx'
import { Skeleton } from '@/components/ui/skeleton'

export function ProjectPage() {
  const { status, systems, error, reload } = useCatalog()
  const found = findApplication(systems, useParams().projectId)

  if (status === 'error') return <CatalogUnavailable error={error!} onRetry={reload} />
  if (status === 'loading') return <Skeleton className="h-40 w-full max-w-xl" />

  if (!found) {
    return (
      <EmptyState title="No such application">
        Nothing in the map has that name. It may have been renamed or removed.
      </EmptyState>
    )
  }

  const { system, app } = found

  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{app.name}</h1>
      <dl className="mt-6 grid max-w-xl grid-cols-[10rem_1fr] gap-y-3 text-sm">
        <dt className="text-muted-foreground">System</dt>
        <dd>{system.projectName}</dd>
        <dt className="text-muted-foreground">Repository</dt>
        <dd>{app.repository ? <code>{app.repository}</code> : '—'}</dd>
        <dt className="text-muted-foreground">Build</dt>
        <dd>{app.buildTechnology ?? '—'}</dd>
        <dt className="text-muted-foreground">Platform</dt>
        <dd>{app.deployPlatform ?? '—'}</dd>
        <dt className="text-muted-foreground">Microservice</dt>
        <dd>{app.microservice === null ? '—' : app.microservice ? 'Yes' : 'No'}</dd>
        <dt className="text-muted-foreground">Environments</dt>
        <dd className="flex flex-wrap gap-1">
          {app.environments.map((env) => (
            <Badge key={env} variant="outline">
              {env}
              {system.teams[env] ? ` · ${system.teams[env]}` : ''}
            </Badge>
          ))}
        </dd>
      </dl>
    </div>
  )
}
