import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { isInFlight, requestsApi, type PortalRequest } from './api.ts'
import { isAvailable, typesByProvider } from './kinds.ts'
import { NewRequestMenuContent } from './new-request-menu.tsx'
import { RequestRow } from './request-row.tsx'

export function MyRequestsPage() {
  usePageTitle('My requests')
  const mine = useResource(() => requestsApi.mine(), [], { pollMs: 10_000 })

  return (
    <div className={PAGE}>
      <PageHeader
        title="My requests"
        description="Everything you have asked DevOps for, newest first."
        actions={<NewButton />}
      />

      <Split
        aside={
          <>
            {mine.data && mine.data.length > 0 && <Summary requests={mine.data} />}
            <AskFor />
          </>
        }
      >
        {mine.error && !mine.data ? (
          <p className="text-sm text-destructive">{mine.error}</p>
        ) : !mine.data ? (
          <Loading label="Loading your requests…">
            <RowsSkeleton rows={5} />
          </Loading>
        ) : mine.data.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center">
            <p className="font-medium">You haven’t asked for anything yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick something from the list beside this, and follow it here until it exists.
            </p>
          </div>
        ) : (
          <Sections requests={mine.data} />
        )}
      </Split>
    </div>
  )
}

function Sections({ requests }: { requests: PortalRequest[] }) {
  const open = requests.filter((r) => isInFlight(r.status) || r.status === 'failed')
  const closed = requests.filter((r) => !open.includes(r))
  return (
    <>
      {open.length > 0 && <Group title="In progress" requests={open} />}
      {closed.length > 0 && <Group title="Done" requests={closed} />}
    </>
  )
}

function Group({ title, requests }: { title: string; requests: PortalRequest[] }) {
  return (
    <Section title={`${title} (${requests.length})`} flush>
      <ul className="divide-y">
        {requests.map((request) => (
          <li key={request.id}>
            <RequestRow request={request} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** How things stand, counted — what someone scans the page for first. */
function Summary({ requests }: { requests: PortalRequest[] }) {
  const count = (test: (r: PortalRequest) => boolean) => requests.filter(test).length
  const failed = count((r) => r.status === 'failed')
  return (
    <Section title="At a glance">
      <Facts
        items={[
          ['Waiting', count((r) => r.status === 'pending')],
          ['Done', count((r) => r.status === 'completed')],
          ['Rejected', count((r) => r.status === 'rejected')],
          // Red only when DevOps has something to retry.
          ['Failed', <span className={failed > 0 ? 'font-medium text-destructive' : ''}>{failed}</span>],
        ]}
      />
    </Section>
  )
}

/**
 * Every request type, spelled out — the same registry as the New request menu,
 * laid open where there is room for it instead of hidden behind a click.
 */
function AskFor() {
  return (
    <Section title="Ask for something" flush>
      {typesByProvider().map(({ provider, types }) => (
        <div key={provider.id} className="border-b last:border-b-0">
          <p className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">{provider.label}</p>
          <ul>
            {types.map((type) => (
              <li key={type.path}>
                {isAvailable(type) ? (
                  <Link to={type.path} className="group flex items-start gap-3 px-4 py-2.5 hover:bg-muted/50">
                    <type.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block font-medium">{type.label}</span>
                      <span className="block text-xs text-muted-foreground">{type.description}</span>
                    </span>
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </Link>
                ) : (
                  <div className="flex items-start gap-3 px-4 py-2.5 text-muted-foreground">
                    <type.icon className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block">{type.label}</span>
                      <span className="block text-xs">{type.description}</span>
                    </span>
                    <span className="self-center rounded-full border px-1.5 text-[10px]">Soon</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  )
}

/** The same menu as the sidebar's, so the two can never offer different things. */
function NewButton() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus /> New request <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <NewRequestMenuContent align="end" />
    </DropdownMenu>
  )
}
