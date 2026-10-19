import { Users } from 'lucide-react'
import { EmptyState } from '@/components/empty-state.tsx'
import { useProfile } from '@/features/auth/profile-context.tsx'
import type { CatalogScope } from './api.ts'

/**
 * Says which part of the catalog this is. Most people see the projects their
 * teams own, not the whole map (the API decides: apps/api modules/access
 * `catalogReach`), and should know the map is theirs rather than think the
 * rest is missing. Nothing is said to someone who sees every project.
 */
export function ScopeNote({ scope, shown }: { scope: CatalogScope | null; shown: number }) {
  if (!scope || scope.all) return null
  return (
    <p className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
      <Users className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        Your teams’ projects: <b className="font-medium text-foreground">{shown}</b> of {scope.total}. A project is yours when its{' '}
        <code>team.yml</code> names one of your groups — as a team, approver or manager — or DevOps gave you access to it.
      </span>
    </p>
  )
}

/** For someone none of whose groups owns a project: why the map is empty, and what to do. */
export function NoProjects() {
  const { profile } = useProfile()
  const groups = profile?.groups ?? []
  return (
    <EmptyState title="None of your teams owns a project yet" icon={Users}>
      The map shows the projects whose <code>team.yml</code> names one of your groups
      {groups.length ? <> ({groups.join(', ')})</> : null}, and none does yet. If you should see a project, ask DevOps — they can give you
      access to a team’s or a project’s, or to every one.
    </EmptyState>
  )
}
