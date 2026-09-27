import { Boxes, FolderGit2, Inbox, KeyRound, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type NavItem = {
  path: string
  label: string
  icon: LucideIcon
  /** Set while the destination does not exist yet. */
  disabled?: boolean
  /** Path prefixes this item stays highlighted for, e.g. a detail page. */
  owns?: string[]
}

/** Whether `pathname` is inside the section this item represents. */
export function isItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.path) return true
  return item.owns?.some((prefix) => pathname.startsWith(prefix)) ?? false
}

/** Things you look at. */
export const browseItems: NavItem[] = [
  { path: '/', label: 'Project map', icon: Boxes, owns: ['/projects'] },
  { path: '/requests', label: 'Requests', icon: Inbox },
]

/** Things you ask the platform team for. */
export const requestItems: NavItem[] = [
  { path: '/requests/new/repository', label: 'A repository', icon: FolderGit2, disabled: true },
  { path: '/requests/new/pipeline', label: 'A pipeline', icon: Workflow, disabled: true },
  { path: '/requests/new/access', label: 'Access to a repository', icon: KeyRound, disabled: true },
]
