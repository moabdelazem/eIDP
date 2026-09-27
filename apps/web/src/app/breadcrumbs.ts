import { findProject } from '@/features/projects/projects.ts'

export type Crumb = {
  label: string
  /** Absent on the last crumb — you are already there. */
  path?: string
}

const sectionLabels: Record<string, string> = {
  '/': 'Project map',
  '/requests': 'Requests',
}

/**
 * The trail for a path. Derived from the URL rather than from route handles,
 * because `useMatches` needs a data router and we use the declarative one.
 *
 * ponytail: dynamic labels are looked up locally. Once the map is loaded from
 * the API, the crumb needs the entity the page already fetched — pass it in
 * rather than growing this lookup.
 */
export function crumbsFor(pathname: string): Crumb[] {
  if (pathname === '/') return [{ label: sectionLabels['/']! }]

  const segments = pathname.split('/').filter(Boolean)

  if (segments[0] === 'projects') {
    const project = findProject(segments[1])
    return [
      { label: sectionLabels['/']!, path: '/' },
      { label: project?.name ?? 'Unknown project' },
    ]
  }

  if (segments[0] === 'requests') {
    return [{ label: sectionLabels['/requests']! }]
  }

  return [{ label: 'Not found' }]
}
