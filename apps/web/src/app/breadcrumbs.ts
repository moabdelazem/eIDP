import { findApplication, type System } from '@/features/projects/catalog.ts'

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
 * Dynamic labels are resolved against the catalog the page already loaded, so
 * the trail never triggers a fetch of its own.
 */
export function crumbsFor(pathname: string, systems: System[] = []): Crumb[] {
  if (pathname === '/') return [{ label: sectionLabels['/']! }]

  const segments = pathname.split('/').filter(Boolean)

  if (segments[0] === 'projects') {
    const found = findApplication(systems, segments[1] ? decodeURIComponent(segments[1]) : undefined)
    return [
      { label: sectionLabels['/']!, path: '/' },
      { label: found?.app.name ?? decodeURIComponent(segments[1] ?? 'Unknown application') },
    ]
  }

  if (segments[0] === 'requests') {
    return [{ label: sectionLabels['/requests']! }]
  }

  return [{ label: 'Not found' }]
}
