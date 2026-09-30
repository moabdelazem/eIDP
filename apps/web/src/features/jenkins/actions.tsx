import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { jenkinsApi, type Build, type QueueItem } from './api.ts'
import { JobName } from './result.tsx'

/**
 * The three things the portal does in Jenkins, each behind a confirmation —
 * they act outside the portal, as the service account, straight away. The
 * toasts say what happened; the API's message is shown when it did not.
 */
async function attempt(action: () => Promise<unknown>, done: string): Promise<boolean> {
  try {
    await action()
    toast.success(done)
    return true
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'That did not go through. Try again.')
    return false
  }
}

export type Pending =
  | { kind: 'rebuild'; build: Pick<Build, 'job' | 'number'> }
  | { kind: 'stop'; build: Pick<Build, 'job' | 'number'> }
  | { kind: 'cancel'; item: QueueItem }

/** One dialog for whichever action is pending; `onDone` reloads what the page shows. */
export function ActionDialog({ pending, onClose, onDone }: { pending: Pending | null; onClose: () => void; onDone: () => void }) {
  // Kept while the dialog animates closed, so its text does not blank out.
  const [shown, setShown] = useState<Pending | null>(pending)
  if (pending && pending !== shown) setShown(pending)
  if (!shown) return null

  const finish = (ok: boolean) => {
    if (ok) onDone()
    return ok
  }

  const common = { open: pending !== null, onOpenChange: (open: boolean) => !open && onClose() }

  if (shown.kind === 'rebuild') {
    const { job, number } = shown.build
    return (
      <ConfirmDialog
        {...common}
        title="Run this build again?"
        confirm="Run again"
        onConfirm={async () => finish(await attempt(() => jenkinsApi.rebuild(job, number), 'Queued in Jenkins'))}
      >
        <p>
          <JobName name={job} className="text-foreground" /> <span className="font-mono">#{number}</span>
        </p>
        <p>Jenkins queues a new build with the same parameters #{number} had. It runs as the portal’s service account; the Activity tab records that you asked.</p>
      </ConfirmDialog>
    )
  }
  if (shown.kind === 'stop') {
    const { job, number } = shown.build
    return (
      <ConfirmDialog
        {...common}
        title="Stop this build?"
        confirm="Stop build"
        destructive
        onConfirm={async () => finish(await attempt(() => jenkinsApi.stop(job, number), 'Asked Jenkins to stop it'))}
      >
        <p>
          <JobName name={job} className="text-foreground" /> <span className="font-mono">#{number}</span>
        </p>
        <p>Jenkins aborts it at the next point it can. Whatever it was deploying may be left half done.</p>
      </ConfirmDialog>
    )
  }
  const { item } = shown
  return (
    <ConfirmDialog
      {...common}
      title="Take it out of the queue?"
      confirm="Remove from queue"
      destructive
      onConfirm={async () => finish(await attempt(() => jenkinsApi.cancel(item.id), 'Removed from the queue'))}
    >
      <p>
        <JobName name={item.job ?? item.name} className="text-foreground" />
      </p>
      <p>The build never starts. To run it later, start it again in Jenkins.</p>
    </ConfirmDialog>
  )
}
