import type { ComponentType } from 'react'
import { Boxes, Inbox, LayoutDashboard, ListChecks, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import type { Permission } from '@/features/auth/profile-context.tsx'

export type NavItem = {
  path: string
  label: string
  /** A Lucide icon, or a brand mark where the page is that product's. */
  icon: ComponentType<{ className?: string }>
  /** Other paths this item stays highlighted for, e.g. its detail pages. */
  owns?: (pathname: string) => boolean
  /** Listed only to people who hold it; the route checks it again. */
  permission?: Permission
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
  { path: '/pipelines', label: 'My pipelines', icon: Workflow, owns: (p) => p.startsWith('/pipelines/'), permission: 'pipelines.view' },
  { path: '/assistant', label: 'Assistant', icon: Sparkles, owns: (p) => p.startsWith('/assistant/'), permission: 'ai.chat' },
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
 * Pages that need a permission beyond being signed in. The sidebar lists each
 * only to people who hold it, and `app/routes.tsx` wraps each path in
 * `RequirePermission` with the same one — a new page goes in both places, or
 * it is reachable by link. The API is what actually refuses.
 */
export const manageItems: (NavItem & { permission: Permission; scoped?: boolean })[] = [
  // Scoped: a team lead has an approvals queue too, holding only their teams'.
  { path: '/approvals', label: 'Approvals', icon: ListChecks, permission: 'requests.decide_access', scoped: true },
  { path: '/jenkins', label: 'Jenkins', icon: JenkinsIcon, permission: 'jenkins.view', owns: (p) => p.startsWith('/jenkins/') },
  { path: '/access', label: 'Access', icon: ShieldCheck, permission: 'rbac.manage' },
]
