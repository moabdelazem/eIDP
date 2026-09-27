import { EmptyState } from '@/components/empty-state.tsx'

export function ProjectMapPage() {
  return (
    <EmptyState title="No projects yet">
      The map is built from the <code>engine</code> repository. Point e-IDP at one and every
      project in the organization shows up here.
    </EmptyState>
  )
}
