import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { projects } from './projects.ts'

export function ProjectMapPage() {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">Project map</h1>
      <p className="mt-2 max-w-prose text-muted-foreground">
        Everything the <code>inventories</code> repository knows about. Placeholder entries until it
        is wired up.
      </p>

      <ul className="mt-6 max-w-2xl divide-y border-y">
        {projects.map((project) => (
          <li key={project.id}>
            <Link
              to={`/projects/${project.id}`}
              className="flex items-baseline gap-3 py-3 hover:bg-muted/50"
            >
              <span className="font-medium">{project.name}</span>
              <code className="text-sm text-muted-foreground">{project.repo}</code>
              <Badge variant="secondary" className="ml-auto">
                {project.team}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
