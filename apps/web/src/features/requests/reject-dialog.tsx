import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/** A rejection without a reason leaves the requester guessing, so one is required. */
export function RejectDialog({
  open,
  onOpenChange,
  what,
  granting = false,
  onReject,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  what: string
  /** An access request: nothing is created, access is not granted. */
  granting?: boolean
  onReject: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote('')
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject this request?</DialogTitle>
          <DialogDescription>
            {granting ? (
              <>
                Access to <span className="font-mono">{what}</span> will not be granted.
              </>
            ) : (
              <>
                <span className="font-mono">{what}</span> will not be created.
              </>
            )}{' '}
            Your reason is shown to the
            person who asked, so they can fix it and ask again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reject-note">Reason</Label>
          <Textarea
            id="reject-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. Use the existing agriland-api repository instead."
            rows={3}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it waiting
          </Button>
          <Button
            variant="destructive"
            disabled={!note.trim() || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onReject(note.trim())
                setNote('')
                onOpenChange(false)
              } finally {
                setBusy(false)
              }
            }}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
