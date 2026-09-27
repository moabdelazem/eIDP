import { FolderGit2, Inbox, KeyRound, Map, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type NavItem = {
  path: string
  label: string
  icon: LucideIcon
}

/** The one list the sidebar renders and the shell reads the page title from. */
export const navItems: NavItem[] = [
  { path: '/', label: 'Project map', icon: Map },
  { path: '/requests', label: 'Requests', icon: Inbox },
]

/** What people will be able to ask for. Disabled until each one is built. */
export const requestKinds: NavItem[] = [
  { path: '/requests/new/repository', label: 'A repository', icon: FolderGit2 },
  { path: '/requests/new/pipeline', label: 'A pipeline', icon: Workflow },
  { path: '/requests/new/access', label: 'Access to a repository', icon: KeyRound },
]

export function titleFor(pathname: string): string {
  return navItems.find((item) => item.path === pathname)?.label ?? 'e-IDP'
}
