import { FolderGit2, FolderKanban } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useResource } from '@/lib/use-resource.ts'
import { isInFlight, requestsApi } from './api.ts'
import { RequestRow } from './request-row.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'

export function MyRequestsPage() {
  usePageTitle('My requests')
  const mine = useResource(() => requestsApi.mine(), [], { pollMs: 10_000 })

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">My requests</h1>
          <p className="mt-1 text-muted-foreground">Everything you have asked DevOps for, newest first.</p>
        </div>
        <NewButtons />
      </div>

      <div className="mt-6">
        {mine.error && !mine.data ? (
          <p className="text-sm text-destructive">{mine.error}</p>
        ) : !mine.data ? (
          <Skeleton className="h-40 w-full" />
        ) : mine.data.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="font-medium">You haven’t asked for anything yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask for a repository or a project, and follow it here until it exists.
            </p>
          </div>
        ) : (
          <Sections requests={mine.data} />
        )}
      </div>
    </div>
  )
}

function Sections({ requests }: { requests: Awaited<ReturnType<typeof requestsApi.mine>> }) {
  const open = requests.filter((r) => isInFlight(r.status) || r.status === 'failed')
  const closed = requests.filter((r) => !open.includes(r))
  return (
    <div className="space-y-8">
      {open.length > 0 && <Group title="In progress" requests={open} />}
      {closed.length > 0 && <Group title="Done" requests={closed} />}
    </div>
  )
}

function Group({ title, requests }: { title: string; requests: Awaited<ReturnType<typeof requestsApi.mine>> }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <ul className="mt-2 divide-y rounded-lg border bg-card">
        {requests.map((request) => (
          <li key={request.id}>
            <RequestRow request={request} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function NewButtons() {
  return (
    <div className="flex gap-2">
      <Button asChild variant="outline" size="sm">
        <Link to="/requests/new/repository">
          <FolderGit2 /> Ask for a repository
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link to="/requests/new/project">
          <FolderKanban /> Ask for a project
        </Link>
      </Button>
    </div>
  )
}
