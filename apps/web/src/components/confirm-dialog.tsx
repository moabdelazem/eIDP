import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Spinner } from '@/components/ui/spinner'

/**
 * Asks before something that acts outside the portal or cannot be taken back,
 * and says exactly what will happen. Stays open until `onConfirm` settles:
 * closing first would hide a failure behind the animation. `onConfirm` reports
 * its own errors (the request actions toast them) and returns whether it
 * worked; the dialog closes only on success.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirm,
  cancel = 'Cancel',
  destructive = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** What will happen, in plain words. */
  children: React.ReactNode
  confirm: string
  cancel?: string
  destructive?: boolean
  onConfirm: () => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async (event) => {
              event.preventDefault()
              setBusy(true)
              const ok = await onConfirm().finally(() => setBusy(false))
              if (ok) onOpenChange(false)
            }}
          >
            {busy && <Spinner />}
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
