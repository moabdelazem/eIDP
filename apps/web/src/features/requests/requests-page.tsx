import { EmptyState } from '@/components/empty-state.tsx'

export function RequestsPage() {
  return (
    <EmptyState title="Nothing requested yet">
      Ask for a repository, a pipeline, or access to something, and track it here.
    </EmptyState>
  )
}
