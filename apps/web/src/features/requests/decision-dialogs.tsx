import { ConfirmDialog } from '@/components/confirm-dialog.tsx'
import { systemOf, targetPath, type PortalRequest } from './api.ts'
import { decide } from './decisions.ts'
import { TargetPath } from './status.tsx'

/** Everyone approval hands access to, as a sentence. */
function who(r: PortalRequest): string {
  const names = r.kind === 'grant_access' ? (r.grantees ?? []) : [r.requestedByName, ...(r.teamGroup ? [r.teamGroup] : [])]
  return names.length <= 1 ? (names[0] ?? 'nobody') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * Approving acts in Azure DevOps or Jira at once, so it asks first — and says exactly
 * what will be created and who will be able to push to it, which is the part
 * people approve without reading when it sits on a card.
 */
export function ApproveDialog({
  request: r,
  open,
  onOpenChange,
  onApproved,
}: {
  request: PortalRequest
  open: boolean
  onOpenChange: (open: boolean) => void
  onApproved: () => void
}) {
  const granting = r.kind === 'grant_access'
  const noun = r.kind === 'create_repository' ? 'repository' : 'project'
  const system = systemOf(r)
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={granting ? 'Approve and grant access?' : `Approve and create this ${noun}?`}
      confirm={granting ? 'Approve and grant' : 'Approve and create'}
      onConfirm={async () => {
        const ok = await decide('approve', r)
        if (ok) onApproved()
        return ok
      }}
    >
      <TargetPath parts={targetPath(r)} className="block text-foreground" />
      <p>
        {granting ? (
          <>
            <span className="text-foreground">{who(r)}</span> will get{' '}
            {r.accessLevel === 'read' ? 'read access' : 'Contributor access'} to{' '}
            {r.repository ? 'this repository' : 'the whole project'} in {system}.
          </>
        ) : (
          <>
            The {noun} is created in {system} straight away, then{' '}
            {system === 'Jira' ? (
              <>
                with <span className="text-foreground">{r.requestedByName}</span> as its lead;{' '}
                <span className="text-foreground">{who(r)}</span> join it as members.
              </>
            ) : (
              <>
                <span className="text-foreground">{who(r)}</span> get Contributor access to it.
              </>
            )}
          </>
        )}
      </p>
      <p>Asked for by {r.requestedByName}. The requester sees who approved it.</p>
    </ConfirmDialog>
  )
}

/** Withdrawing cannot be undone — a new request would start over — so it asks. */
export function WithdrawDialog({
  request: r,
  open,
  onOpenChange,
  onWithdrawn,
}: {
  request: PortalRequest
  open: boolean
  onOpenChange: (open: boolean) => void
  onWithdrawn: () => void
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Withdraw this request?"
      confirm="Withdraw"
      cancel="Keep it"
      destructive
      onConfirm={async () => {
        const ok = await decide('cancel', r)
        if (ok) onWithdrawn()
        return ok
      }}
    >
      <TargetPath parts={targetPath(r)} className="block text-foreground" />
      <p>DevOps stop seeing it, and it cannot be picked up again. To ask later, file a new request.</p>
    </ConfirmDialog>
  )
}
