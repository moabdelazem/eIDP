import { findApplication, type System } from '@/features/projects/catalog.ts'
import { typeForPath } from '@/features/requests/kinds.ts'

export type Crumb = {
  label: string
  /** Absent on the last crumb — you are already there. */
  path?: string
}

const sectionLabels: Record<string, string> = {
  '/': 'Overview',
  '/map': 'Projects map',
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
  if (pathname === '/map') return [{ label: sectionLabels['/map']! }]

  const segments = pathname.split('/').filter(Boolean)

  if (segments[0] === 'projects') {
    const found = findApplication(systems, segments[1] ? decodeURIComponent(segments[1]) : undefined)
    return [
      { label: sectionLabels['/map']!, path: '/map' },
      { label: found?.app.name ?? decodeURIComponent(segments[1] ?? 'Unknown application') },
    ]
  }

  if (segments[0] === 'requests') {
    const mine = { label: 'My requests', path: '/requests' }
    if (segments[1] === 'new') {
      return [mine, { label: typeForPath(pathname)?.title ?? 'New request' }]
    }
    if (segments[1]) return [mine, { label: 'Request' }]
    return [{ label: 'My requests' }]
  }

  if (segments[0] === 'approvals') return [{ label: 'Approvals' }]
  if (segments[0] === 'me') return [{ label: 'Your profile' }]
  if (segments[0] === 'access') return [{ label: 'Access' }]
  if (segments[0] === 'assistant') {
    return segments[1] ? [{ label: 'Assistant', path: '/assistant' }, { label: 'Conversation' }] : [{ label: 'Assistant' }]
  }
  if (segments[0] === 'system') return [{ label: 'System health' }]
  if (segments[0] === 'digest') return [{ label: 'Weekly digest' }]
  if (segments[0] === 'pipelines') {
    return segments[1] === 'build' ? [{ label: 'My pipelines', path: '/pipelines' }, { label: 'Build' }] : [{ label: 'My pipelines' }]
  }
  if (segments[0] === 'jenkins') {
    return segments[1] === 'build' ? [{ label: 'Jenkins', path: '/jenkins' }, { label: 'Build' }] : [{ label: 'Jenkins' }]
  }

  return [{ label: 'Not found' }]
}
