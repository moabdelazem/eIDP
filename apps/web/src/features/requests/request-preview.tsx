import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import { Facts } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { targetPath, type PortalRequest } from './api.ts'
import { AccessLine, KIND_LABEL, StatusBadge, TargetPath } from './status.tsx'

/**
 * A request at a glance, over the table it was picked from — so reading
 * through history is not a page load and a Back per row. Everything that
 * decides or changes it stays on the request's own page, one link away.
 */
export function RequestPreview({ request: r, onClose }: { request: PortalRequest | null; onClose: () => void }) {
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null)
  return (
    <Dialog open={r !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {r && (
          <>
            <DialogHeader>
              <div className="flex items-start justify-between gap-3 pr-6">
                <DialogTitle className="font-mono break-words">{r.repository ?? r.project}</DialogTitle>
                <StatusBadge status={r.status} kind={r.kind} />
              </div>
              <DialogDescription asChild>
                <div>
                  <TargetPath parts={targetPath(r)} className="text-xs" />
                </div>
              </DialogDescription>
            </DialogHeader>

            <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">{r.justification}</blockquote>

            {r.decisionNote && (
              <p className={`rounded-md border p-3 text-sm ${r.status === 'rejected' ? 'border-destructive/30 bg-destructive/5' : 'bg-muted/40'}`}>
                <span className="font-medium">{r.decidedByName}:</span> {r.decisionNote}
              </p>
            )}
            {r.error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{r.error}</p>
            )}

            <Facts
              empty="—"
              items={[
                ['Type', r.kind === 'grant_access' ? 'Access to a project' : KIND_LABEL[r.kind]],
                ['Access', <AccessLine request={r} />],
                ['Requested by', r.requestedByName],
                ['Requested', at(r.requestedAt)],
                ['Decided by', r.decidedByName],
                ['Decided', at(r.decidedAt)],
                ['Finished', at(r.completedAt)],
              ]}
            />

            <DialogFooter>
              <Button asChild>
                <Link to={`/requests/${r.id}`}>
                  Open request <ArrowRight />
                </Link>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
