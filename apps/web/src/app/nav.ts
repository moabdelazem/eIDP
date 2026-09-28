import { Boxes, Inbox, LayoutDashboard, ListChecks } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type NavItem = {
  path: string
  label: string
  icon: LucideIcon
  /** Other paths this item stays highlighted for, e.g. its detail pages. */
  owns?: (pathname: string) => boolean
}

/** Whether `pathname` is inside the section this item represents. */
export function isItemActive(item: NavItem, pathname: string): boolean {
  return pathname === item.path || (item.owns?.(pathname) ?? false)
}

const REQUEST_DETAIL = /^\/requests\/[0-9a-f-]{36}$/i

/** Things you look at. */
export const browseItems: NavItem[] = [
  { path: '/', label: 'Overview', icon: LayoutDashboard },
  { path: '/map', label: 'Projects map', icon: Boxes, owns: (p) => p.startsWith('/projects') },
]

/**
 * Where you follow what you asked for. The kinds of request themselves are not
 * nav items — they live in `features/requests/kinds.ts` and open from the New
 * request menu, because there will be too many for a flat list.
 */
export const requestItems: NavItem[] = [
  { path: '/requests', label: 'My requests', icon: Inbox, owns: (p) => REQUEST_DETAIL.test(p) },
]

/**
 * The DevOps-only pages. The sidebar shows this group only to DevOps, and
 * `app/routes.tsx` puts every one of these paths behind `RequireDevOps` —
 * a new admin page goes in both places, or it is reachable by link.
 */
export const devopsItems: NavItem[] = [
  { path: '/approvals', label: 'Approvals', icon: ListChecks },
]
