import { useParams } from 'react-router'
import { EmptyState } from '@/components/empty-state.tsx'
import { findProject } from './projects.ts'

export function ProjectPage() {
  const project = findProject(useParams().projectId)

  if (!project) {
    return (
      <EmptyState title="No such project">
        Nothing in the map has that name. It may have been renamed or removed.
      </EmptyState>
    )
  }

  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{project.name}</h1>
      <dl className="mt-6 grid max-w-md grid-cols-[8rem_1fr] gap-y-3 text-sm">
        <dt className="text-muted-foreground">Team</dt>
        <dd>{project.team}</dd>
        <dt className="text-muted-foreground">Repository</dt>
        <dd>
          <code>{project.repo}</code>
        </dd>
        <dt className="text-muted-foreground">Language</dt>
        <dd>{project.language}</dd>
      </dl>
    </div>
  )
}
