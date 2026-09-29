import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Eye, Search } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PortalRequest, RequestKind, RequestStatus } from './api.ts'
import { STATUS_NAME } from './request-stats.tsx'
import { RequestPreview } from './request-preview.tsx'
import { KIND_ICON, KIND_LABEL, StatusBadge } from './status.tsx'

const PAGE_SIZE = 20

type SortKey = 'name' | 'kind' | 'status' | 'requester' | 'requested' | 'decided'

/**
 * Requests as a table — for looking back through history, where a list of
 * cards is too slow to scan. Searchable, filterable by status and type,
 * sortable by any column, and paged. Every name links to the request.
 *
 * The status filter is lifted, so the stat tiles above can set it.
 *
 * ponytail: sorts and filters in the browser over what the API sent (its
 * HISTORY_LIMIT newest). Server-side paging when that stops being everything.
 */
export function RequestsTable({
  requests,
  status,
  onStatus,
  showRequester = false,
}: {
  requests: PortalRequest[]
  status: RequestStatus | 'all'
  onStatus: (status: RequestStatus | 'all') => void
  showRequester?: boolean
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<RequestKind | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'requested', desc: true })
  const [page, setPage] = useState(0)
  const [previewing, setPreviewing] = useState<PortalRequest | null>(null)

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = requests.filter(
      (r) =>
        (status === 'all' || r.status === status) &&
        (kind === 'all' || r.kind === kind) &&
        (!needle ||
          [r.repository, r.project, r.collection, r.requestedByName, r.requestedBy, r.decidedByName, ...(r.grantees ?? [])]
            .filter(Boolean)
            .some((text) => text!.toLowerCase().includes(needle))),
    )
    const value = (r: PortalRequest): string =>
      sort.key === 'name'
        ? (r.repository ?? r.project).toLowerCase()
        : sort.key === 'kind'
          ? KIND_LABEL[r.kind]
          : sort.key === 'status'
            ? STATUS_NAME[r.status]
            : sort.key === 'requester'
              ? r.requestedByName.toLowerCase()
              : sort.key === 'requested'
                ? r.requestedAt
                : (r.decidedAt ?? '')
    return filtered.sort((a, b) => value(a).localeCompare(value(b)) * (sort.desc ? -1 : 1))
  }, [requests, status, kind, query, sort])

  // Any change to what is shown starts again at the first page.
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPage(0)
  }

  const kinds = [...new Set(requests.map((r) => r.kind))]

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search requests"
            placeholder="Search by name, project or person"
            value={query}
            onChange={(e) => reset(setQuery)(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={status} onValueChange={(v) => reset(onStatus)(v as RequestStatus | 'all')}>
          <SelectTrigger aria-label="Status" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {(Object.keys(STATUS_NAME) as RequestStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_NAME[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {kinds.length > 1 && (
          <Select value={kind} onValueChange={(v) => reset(setKind)(v as RequestKind | 'all')}>
            <SelectTrigger aria-label="Type" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any type</SelectItem>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <SortHead label="Name" sortKey="name" sort={sort} onSort={setSort} />
            <SortHead label="Type" sortKey="kind" sort={sort} onSort={setSort} className="hidden md:table-cell" />
            <SortHead label="Status" sortKey="status" sort={sort} onSort={setSort} />
            {showRequester && <SortHead label="Requested by" sortKey="requester" sort={sort} onSort={setSort} className="hidden lg:table-cell" />}
            <SortHead label="Requested" sortKey="requested" sort={sort} onSort={setSort} className="hidden sm:table-cell" />
            <SortHead label="Decided" sortKey="decided" sort={sort} onSort={setSort} className="hidden xl:table-cell" />
            <TableHead className="w-12">
              <span className="sr-only">Preview</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                No requests match.
              </TableCell>
            </TableRow>
          ) : (
            shown.map((r) => {
              const Icon = KIND_ICON[r.kind]
              return (
                <TableRow key={r.id}>
                  <TableCell className="max-w-72">
                    <Link to={`/requests/${r.id}`} className="group flex items-center gap-2">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-mono group-hover:underline">{r.repository ?? r.project}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {r.repository ? `${r.collection} / ${r.project}` : r.collection}
                        </span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{KIND_LABEL[r.kind]}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} kind={r.kind} />
                  </TableCell>
                  {showRequester && <TableCell className="hidden lg:table-cell">{r.requestedByName}</TableCell>}
                  <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell" title={new Date(r.requestedAt).toLocaleString()}>
                    {new Date(r.requestedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground xl:table-cell">
                    {r.decidedByName ? (
                      <>
                        {r.decidedByName}
                        {r.decidedAt && <span className="block text-xs tabular-nums">{new Date(r.decidedAt).toLocaleDateString()}</span>}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={`Preview ${r.repository ?? r.project}`}
                      onClick={() => setPreviewing(r)}
                    >
                      <Eye className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {rows.length === 0
            ? 'None'
            : `${current * PAGE_SIZE + 1}–${Math.min((current + 1) * PAGE_SIZE, rows.length)} of ${rows.length}`}
        </span>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="size-8" aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}>
            <ChevronLeft />
          </Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Next page" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            <ChevronRight />
          </Button>
        </div>
      </div>

      <RequestPreview request={previewing} onClose={() => setPreviewing(null)} />
    </div>
  )
}

function SortHead({
  label,
  sortKey,
  sort,
  onSort,
  className = '',
}: {
  label: string
  sortKey: SortKey
  sort: { key: SortKey; desc: boolean }
  onSort: (sort: { key: SortKey; desc: boolean }) => void
  className?: string
}) {
  const active = sort.key === sortKey
  const Icon = !active ? ArrowUpDown : sort.desc ? ArrowDown : ArrowUp
  return (
    <TableHead className={className} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort({ key: sortKey, desc: active ? !sort.desc : sortKey === 'requested' || sortKey === 'decided' })}
        className="-ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {label}
        <Icon className={`size-3.5 ${active ? '' : 'opacity-40'}`} />
      </button>
    </TableHead>
  )
}
