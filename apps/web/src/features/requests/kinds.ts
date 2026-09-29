import type { ComponentType } from 'react'
import { ClipboardList, FolderGit2, FolderKanban, KeyRound, type LucideIcon } from 'lucide-react'
import { AzureDevOpsIcon, JiraIcon } from '@/components/brand-icons.tsx'
import type { RequestKind } from './api.ts'

/**
 * Everything someone can ask for, in one list. The sidebar's New request menu,
 * the My requests button, the Ctrl/⌘ K palette, the routes and the
 * breadcrumbs all read it — a new kind of request is one entry here plus its
 * form, not six scattered edits.
 */

export type ProviderId = 'azure-devops' | 'jira'

export const PROVIDERS: { id: ProviderId; label: string; icon: ComponentType<{ className?: string; tone?: 'brand' | 'current' }> }[] = [
  { id: 'azure-devops', label: 'Azure DevOps', icon: AzureDevOpsIcon },
  { id: 'jira', label: 'Jira', icon: JiraIcon },
]

export type RequestType = {
  provider: ProviderId
  /** Short, because the provider is already the heading above it. */
  label: string
  /** The page title, which has no heading to lean on. */
  title: string
  description: string
  icon: LucideIcon
  /**
   * Scoped by provider: an Azure DevOps project and a Jira project are
   * different things, and `/requests/new/project` could not tell them apart.
   */
  path: string
  /** The API kind it files, or null while the backend does not exist yet. */
  kind: RequestKind | null
}

export const REQUEST_TYPES: RequestType[] = [
  {
    provider: 'azure-devops',
    label: 'Repository',
    title: 'New Azure DevOps repository',
    description: 'A Git repository in an existing project',
    icon: FolderGit2,
    path: '/requests/new/azure-devops/repository',
    kind: 'create_repository',
  },
  {
    provider: 'azure-devops',
    label: 'Project',
    title: 'New Azure DevOps project',
    description: 'A project with Git, in any collection',
    icon: FolderKanban,
    path: '/requests/new/azure-devops/project',
    kind: 'create_project',
  },
  {
    provider: 'azure-devops',
    label: 'Access',
    title: 'Access to Azure DevOps',
    description: 'Contribute on an existing project',
    icon: KeyRound,
    path: '/requests/new/azure-devops/access',
    kind: 'grant_access',
  },
  {
    provider: 'jira',
    label: 'Project',
    title: 'New Jira project',
    description: 'A Jira project for a team',
    icon: ClipboardList,
    path: '/requests/new/jira/project',
    // Shown so the menu's shape is honest about what is coming, but not
    // offered until the integration exists.
    kind: null,
  },
]

export function isAvailable(type: RequestType): boolean {
  return type.kind !== null
}

/** Grouped by provider, in PROVIDERS order, skipping providers with nothing. */
export function typesByProvider(): { provider: (typeof PROVIDERS)[number]; types: RequestType[] }[] {
  return PROVIDERS.map((provider) => ({
    provider,
    types: REQUEST_TYPES.filter((type) => type.provider === provider.id),
  })).filter((group) => group.types.length > 0)
}

export function typeForPath(pathname: string): RequestType | undefined {
  return REQUEST_TYPES.find((type) => type.path === pathname)
}
