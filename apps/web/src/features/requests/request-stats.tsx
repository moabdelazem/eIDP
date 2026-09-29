import type { PortalRequest, RequestStatus } from './api.ts'

/**
 * A status's name as a filter — shorter and kind-neutral, unlike the badge's
 * "Created"/"Granted". The tiles and the table's status filter share it, so
 * picking the Done tile shows "Done" in the filter too.
 */
export const STATUS_NAME: Record<RequestStatus, string> = {
  pending: 'Waiting',
  approved: 'In progress',
  completed: 'Done',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Withdrawn',
}

/** The order tiles read in: what is moving, then how things ended. */
const TILES: { status: RequestStatus | 'all'; label: string }[] = [
  { status: 'all', label: 'All requests' },
  ...(Object.keys(STATUS_NAME) as RequestStatus[]).map((status) => ({ status, label: STATUS_NAME[status] })),
]

/**
 * A count per status, as a row of tiles. Each tile is a filter: choosing one
 * narrows the table below to that status, and choosing it again clears it.
 *
 * Red only where someone has to act — `attention` names those statuses (Failed
 * everywhere, Waiting too on an approver's page) and only when the count is
 * above zero.
 */
export function RequestStats({
  requests,
  active,
  onPick,
  attention = ['failed'],
}: {
  requests: PortalRequest[]
  active: RequestStatus | 'all'
  onPick: (status: RequestStatus | 'all') => void
  attention?: RequestStatus[]
}) {
  const count = (status: RequestStatus | 'all') =>
    status === 'all' ? requests.length : requests.filter((r) => r.status === status).length

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
      {TILES.map(({ status, label }) => {
        const n = count(status)
        const selected = active === status
        const alarm = status !== 'all' && attention.includes(status) && n > 0
        return (
          // A card that is a button: shadcn's Card is a div, and a filter must be
          // reachable by keyboard.
          <button
            key={status}
            type="button"
            aria-pressed={selected}
            onClick={() => onPick(selected && status !== 'all' ? 'all' : status)}
            className={`rounded-xl border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
              selected ? 'border-ring ring-1 ring-ring/40' : ''
            }`}
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className={`mt-1 block text-2xl font-semibold tabular-nums ${alarm ? 'text-primary' : ''}`}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}
