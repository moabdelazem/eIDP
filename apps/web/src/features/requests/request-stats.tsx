import type { PortalRequest, RequestStatus } from './api.ts'
import { statusTone } from './status.tsx'
import { StatTile } from '@/components/stat-tile.tsx'

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
          <StatTile
            key={status}
            group="request-stats"
            label={label}
            value={n}
            dot={status !== 'all' ? statusTone(status).dot : null}
            alarm={alarm}
            selected={selected}
            onClick={() => onPick(selected && status !== 'all' ? 'all' : status)}
          />
        )
      })}
    </div>
  )
}
