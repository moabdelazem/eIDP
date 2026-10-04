import { useState } from 'react'
import { Link } from 'react-router'
import { EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { since } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { buildPath, IGNORE_FOR_LABEL, jenkinsApi, type Failure, type Ignore, type IgnoreFor } from './api.ts'
import { JobName, ResultBadge } from './result.tsx'

/**
 * Setting a failing job aside — known broken and being dealt with, or
 * abandoned — so "failing now" is what still needs someone. A Dialog, not a
 * confirmation: it acts only inside the portal and is undone in one click.
 * The reason is required, because the next person to see it will ask why.
 */
export function IgnoreDialog({ job, onClose, onDone }: { job: string | null; onClose: () => void; onDone: () => void }) {
  const [until, setUntil] = useState<IgnoreFor>('pass')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  // Kept while the dialog animates closed, so its text does not blank out.
  const [shown, setShown] = useState(job)
  if (job && job !== shown) setShown(job)

  const close = () => {
    setReason('')
    setUntil('pass')
    onClose()
  }

  return (
    <Dialog open={job !== null} onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ignore this failure?</DialogTitle>
          <DialogDescription>
            <JobName name={shown ?? ''} className="text-foreground" /> leaves the failing list, its count and the automatic explanations. It stays listed under
            Ignored, where anyone who may act on Jenkins can bring it back.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ignore-until">For how long</Label>
            <Select value={until} onValueChange={(value) => setUntil(value as IgnoreFor)}>
              <SelectTrigger id="ignore-until" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(IGNORE_FOR_LABEL) as IgnoreFor[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {IGNORE_FOR_LABEL[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {until === 'pass' && <p className="text-xs text-muted-foreground">If it fails again after passing, it comes back.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="ignore-reason">Why</Label>
            <Textarea
              id="ignore-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Known flaky integration test, tracked in PAY-77."
              rows={3}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Keep it on the list
          </Button>
          <Button
            disabled={reason.trim().length < 3 || busy || !shown}
            onClick={async () => {
              setBusy(true)
              try {
                await jenkinsApi.ignore(shown!, until, reason.trim())
                toast.success('Ignored — it is under Ignored on the Failing tab')
                onDone()
                close()
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'That did not go through. Try again.')
              } finally {
                setBusy(false)
              }
            }}
          >
            <EyeOff /> Ignore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Until it passes", "until Oct 12", "until someone stops it". */
export function ignoreUntil(ignore: Ignore): string {
  if (ignore.untilPass) return 'until it passes'
  if (!ignore.expiresAt) return 'until someone stops it'
  return `until ${new Date(ignore.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

/** The failures set aside, each with who, why and until when, and a way back. */
export function IgnoredList({ failures, canOperate, onDone }: { failures: Failure[]; canOperate: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (failures.length === 0) return null
  return (
    <section className="mt-6" aria-labelledby="ignored-heading">
      <h2 id="ignored-heading" className="mb-2 flex items-center gap-2 text-sm font-medium">
        <EyeOff className="size-4 text-muted-foreground" aria-hidden /> Ignored <span className="text-muted-foreground tabular-nums">{failures.length}</span>
      </h2>
      <ul className="divide-y rounded-xl border bg-card">
        {failures.map((f) => (
          <li key={f.job} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-1">
              <Link to={buildPath(f.last)} className="flex flex-wrap items-center gap-2 hover:underline">
                <JobName name={f.job} className="text-sm" />
                <ResultBadge result={f.last.result} />
                <span className="font-mono text-xs text-muted-foreground">#{f.last.number}</span>
              </Link>
              <p className="text-sm">{f.ignored!.reason}</p>
              <p className="text-xs text-muted-foreground">
                Ignored by {f.ignored!.byName} · {since(f.ignored!.at)} · {ignoreUntil(f.ignored!)}
              </p>
            </div>
            {canOperate && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === f.job}
                onClick={async () => {
                  setBusy(f.job)
                  try {
                    await jenkinsApi.unignore(f.job)
                    toast.success('Back on the failing list')
                    onDone()
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : 'That did not go through. Try again.')
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                Stop ignoring
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
