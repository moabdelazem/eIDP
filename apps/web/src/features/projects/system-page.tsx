import { useState } from 'react'
import { Check, Clock, ExternalLink, FolderGit2, KeyRound, Map as MapIcon, Plus, TriangleAlert, User, UserMinus, Users, Workflow } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { EmptyState } from '@/components/empty-state.tsx'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { FactsSkeleton, HeaderSkeleton, Loading } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { fetchProjectView, type ProjectMember, type ProjectRepository, type ProjectView } from './api.ts'
import { useCatalog } from './catalog-context.tsx'
import { inOrder, envLabel } from './tree.ts'

/**
 * A project as a place to work — the old portal's Code Control page, without
 * its traps: the repositories in its Azure DevOps project, each with whether
 * it has a pipeline, and who can work in it. Anything to change is a request:
 * a repository, a pipeline, access, or taking access away.
 *
 * Whether a repository has a pipeline comes from the catalog (inventories
 * builds an application from it), read with the page — not one lookup per
 * repository on every click, as the old page made.
 */
export function SystemPage() {
  const { systemId = '' } = useParams()
  const { systems } = useCatalog()
  const system = systems.find((s) => s.id === systemId)
  const view = useResource(['projects', 'view', systemId], () => fetchProjectView(systemId))
  usePageTitle(view.data?.system.projectName ?? system?.projectName ?? 'Project')

  if (view.error && !view.data) {
    return (
      <EmptyState title="No such project">
        Nothing in your teams’ projects has that name. It may belong to a team you are not in, or have been renamed or removed from <code>inventories</code>.
      </EmptyState>
    )
  }
  if (!view.data) {
    return (
      <Loading className={PAGE} label="Loading the project…">
        <HeaderSkeleton />
        <FactsSkeleton className="mt-8" />
      </Loading>
    )
  }

  const v = view.data
  // Application names to their pages, from the catalog the map already loaded.
  const appIds = new Map((system?.applications ?? []).map((app) => [app.name.toLowerCase(), app.id]))

  return (
    <div className={PAGE}>
      <PageHeader
        title={<h1 className="font-mono text-lg font-semibold break-words">{v.system.projectName}</h1>}
        description={
          <>
            Project{v.system.company ? ` at ${v.system.company}` : ''}
            {v.ado && (
              <>
                {' '}
                · in <code>{v.ado.collection}</code>
              </>
            )}
          </>
        }
        actions={
          <>
            {v.ado && (
              <Button asChild variant="outline" size="sm">
                <a href={v.ado.url} target="_blank" rel="noreferrer">
                  Open in Azure DevOps <ExternalLink />
                </a>
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to={`/map?${new URLSearchParams({ q: v.system.projectName })}`}>
                <MapIcon /> On the map
              </Link>
            </Button>
          </>
        }
      />

      <Split
        aside={
          <>
            <AccessSection view={v} />
            <Section title="Who owns it, by environment">
              {Object.keys(v.system.teams).length === 0 ? (
                <p className="text-sm text-muted-foreground">No owning team is recorded for this project.</p>
              ) : (
                <Facts items={inOrder(Object.keys(v.system.teams)).map((env) => [envLabel(env), v.system.teams[env]])} />
              )}
            </Section>
          </>
        }
      >
        <CodeSection view={v} appIds={appIds} />
      </Split>
    </div>
  )
}

// ---- code --------------------------------------------------------------------

const pipelineFormFor = (v: ProjectView, repository: string) =>
  `/requests/new/jenkins/pipeline?${new URLSearchParams({ collection: v.ado!.collection, project: v.ado!.project, repository })}`

function CodeSection({ view: v, appIds }: { view: ProjectView; appIds: Map<string, string> }) {
  const { can } = useProfile()
  const asking = can('requests.create')
  const withPipeline = v.repositories.filter((r) => r.applications.length > 0).length
  const asked = v.repositories.filter((r) => r.applications.length === 0 && r.pipelineRequest).length
  const without = v.repositories.length - withPipeline - asked
  return (
    <Section
      title="Code"
      flush
      description={
        v.repositories.length > 0
          ? `${v.repositories.length} ${v.repositories.length === 1 ? 'repository' : 'repositories'}: ${withPipeline} with a pipeline${asked ? `, ${asked} asked for` : ''}${without ? `, ${without} without` : ''}.`
          : 'The Git repositories in its Azure DevOps project, and their pipelines.'
      }
      action={
        v.ado && asking ? (
          <Button asChild size="sm" variant="outline">
            <Link to={`/requests/new/azure-devops/repository?${new URLSearchParams({ collection: v.ado.collection, project: v.ado.project })}`}>
              <Plus /> New repository
            </Link>
          </Button>
        ) : undefined
      }
    >
      {v.repositoriesError ? (
        <Problem>{v.repositoriesError}</Problem>
      ) : v.repositories.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted-foreground">No repositories yet.</p>
      ) : (
        <ul className="divide-y">
          {v.repositories.map((repo) => (
            <RepositoryRow key={repo.name} view={v} repo={repo} appIds={appIds} asking={asking} />
          ))}
        </ul>
      )}
    </Section>
  )
}

function RepositoryRow({ view: v, repo, appIds, asking }: { view: ProjectView; repo: ProjectRepository; appIds: Map<string, string>; asking: boolean }) {
  return (
    <li className="flex flex-col gap-2 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2.5">
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {repo.url ? (
          <a href={repo.url} target="_blank" rel="noreferrer" className="truncate font-mono text-sm hover:underline">
            {repo.name}
          </a>
        ) : (
          <span className="truncate font-mono text-sm">{repo.name}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
        {repo.applications.length > 0 ? (
          <>
            <Chip tone="success" icon={<Check />}>
              Pipeline
            </Chip>
            {repo.applications.map((name) => {
              const id = appIds.get(name.toLowerCase())
              return id ? (
                <Link key={name} to={`/projects/${encodeURIComponent(id)}`} className="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {name}
                </Link>
              ) : (
                <span key={name} className="font-mono text-xs text-muted-foreground">
                  {name}
                </span>
              )
            })}
          </>
        ) : repo.pipelineRequest ? (
          <Link to={`/requests/${repo.pipelineRequest.id}`} className="rounded-full focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
            <Chip tone="info" icon={<Clock />}>
              Pipeline asked for
            </Chip>
          </Link>
        ) : (
          <>
            <Chip tone="muted">No pipeline</Chip>
            {asking && v.ado && (
              <Button asChild size="sm" variant="ghost" className="h-7">
                <Link to={pipelineFormFor(v, repo.name)}>
                  <Workflow /> Set up a pipeline
                </Link>
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

// ---- access ------------------------------------------------------------------

/**
 * Who can work in it: everyone directly in its Contributors or Readers. Tick
 * people and ask to remove them — a request, decided by DevOps or the
 * project's team lead, never a removal on the spot as the old page made for
 * managers.
 */
function AccessSection({ view: v }: { view: ProjectView }) {
  const { can } = useProfile()
  const asking = can('requests.create') && v.ado !== null
  const [chosen, setChosen] = useState<string[]>([])
  const toggle = (account: string, on: boolean) => setChosen((now) => (on ? [...now, account] : now.filter((a) => a !== account)))
  const removable = v.members.filter((m) => !m.removal)
  const removeLink = v.ado ? `/requests/new/azure-devops/remove-access?${new URLSearchParams({ collection: v.ado.collection, project: v.ado.project, people: chosen.join(',') })}` : ''
  const askLink = v.ado ? `/requests/new/azure-devops/access?${new URLSearchParams({ collection: v.ado.collection, project: v.ado.project })}` : `/requests/new/azure-devops/access?${new URLSearchParams({ project: v.system.projectName })}`

  return (
    <Section
      title="Who can work in it"
      flush
      description={v.members.length > 0 ? `${v.members.length} in its Contributors and Readers in Azure DevOps.` : 'Everyone in its Contributors and Readers in Azure DevOps.'}
    >
      {v.membersError ? (
        <Problem>{v.membersError}</Problem>
      ) : v.members.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted-foreground">Nobody yet.</p>
      ) : (
        <ul className="max-h-[28rem] divide-y overflow-y-auto">
          {v.members.map((member) => (
            <MemberRow key={member.account} member={member} chosen={chosen.includes(member.account)} onChoose={asking && !member.removal ? (on) => toggle(member.account, on) : undefined} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t px-6 py-3">
        {asking && removable.length > 0 && (
          chosen.length > 0 ? (
            <Button asChild size="sm" variant="outline">
              <Link to={removeLink}>
                <UserMinus /> Ask to remove {chosen.length}
              </Link>
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              <UserMinus /> Tick people to remove
            </Button>
          )
        )}
        {can('requests.create') && (
          <Button asChild size="sm" variant="ghost">
            <Link to={askLink}>
              <KeyRound /> Ask for access
            </Link>
          </Button>
        )}
      </div>
    </Section>
  )
}

function MemberRow({ member: m, chosen, onChoose }: { member: ProjectMember; chosen: boolean; onChoose?: (on: boolean) => void }) {
  const id = `member-${m.account}`
  const Icon = m.group ? Users : User
  const readOnly = !m.in.includes('Contributors')
  const body = (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{m.group ? <code className="text-[13px]">{m.account}</code> : m.displayName}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {m.group ? 'A group — everyone in it' : <code>{m.account}</code>}
          {readOnly && ' · reads only'}
        </span>
      </span>
    </>
  )
  return (
    <li className="flex items-center gap-3 px-6 py-2.5">
      {onChoose ? (
        <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
          <Checkbox id={id} checked={chosen} onCheckedChange={(on) => onChoose(on === true)} aria-label={`Choose ${m.account} to remove`} />
          {body}
        </label>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">
          {/* Lines up with the rows that have a box. */}
          {m.removal && <span className="size-4 shrink-0" aria-hidden />}
          {body}
        </span>
      )}
      {m.removal && (
        <Link to={`/requests/${m.removal.id}`} className="shrink-0 rounded-full focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" title={`Asked by ${m.removal.requestedByName}`}>
          <Chip tone="warning" icon={<Clock />}>
            Removal asked
          </Chip>
        </Link>
      )}
    </li>
  )
}

// ---- parts ---------------------------------------------------------------------

const TONE = {
  success: 'border-success/25 bg-success-soft text-success',
  info: 'border-info/25 bg-info-soft text-info',
  warning: 'border-warning/25 bg-warning-soft text-warning',
  muted: 'text-muted-foreground',
}

/** A state in a word, with its icon when the colour means something. */
function Chip({ tone, icon, children }: { tone: keyof typeof TONE; icon?: React.ReactNode; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium [&_svg]:size-3 ${TONE[tone]}`}>{icon}{children}</span>
}

/** What Azure DevOps could not answer, in place of the list it would have filled. */
function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 px-6 py-4 text-sm text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> {children}
    </p>
  )
}
