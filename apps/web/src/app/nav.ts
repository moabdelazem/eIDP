import { Boxes, FolderGit2, FolderKanban, Inbox, ListChecks } from 'lucide-react'
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
  { path: '/', label: 'Project map', icon: Boxes, owns: (p) => p.startsWith('/projects') },
]

/** Things you ask DEVOPS for, and where you follow them. */
export const requestItems: NavItem[] = [
  { path: '/requests/new/repository', label: 'Ask for a repository', icon: FolderGit2 },
  { path: '/requests/new/project', label: 'Ask for a project', icon: FolderKanban },
  { path: '/requests', label: 'My requests', icon: Inbox, owns: (p) => REQUEST_DETAIL.test(p) },
]

/** Only offered to members of the approver group. */
export const approvalsItem: NavItem = { path: '/approvals', label: 'Approvals', icon: ListChecks }
