import { useState } from 'react'
import { Check, Clock, Mail, RotateCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Section } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type SentMail } from './api.ts'
import { since } from './status.tsx'

/**
 * The mail sent about this request — to whom, and whether it went — for the
 * people who may decide it. A refusal is retried by the portal on its own;
 * *Send again* is for after the cause is fixed, or a copy of one that went.
 * Hidden while there is none, which is always where mail is not set up.
 */
export function EmailsSection({ requestId, status }: { requestId: string; status: string }) {
  const [pollMs, setPollMs] = useState<number | null>(null)
  // Keyed on the status too: a decision queues mail, and the list should show it.
  const emails = useResource(
    ['requests', 'emails', requestId, status],
    async () => {
      const found = await requestsApi.emails(requestId)
      setPollMs(found.some((m) => m.status === 'pending' || m.status === 'sending') ? 5000 : null)
      return found
    },
    { pollMs },
  )
  const [busy, setBusy] = useState<number | null>(null)
  if (!emails.data || emails.data.length === 0) return null

  async function resend(mail: SentMail) {
    setBusy(mail.id)
    try {
      await requestsApi.resendEmail(requestId, mail.id)
      toast.success(mail.status === 'sent' ? 'Sending a copy' : 'Sending it again')
      emails.reload()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send it again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Sent by email" flush>
      <ul className="divide-y">
        {emails.data.map((mail) => (
          <li key={mail.id} className="space-y-1.5 px-6 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="flex min-w-0 items-start gap-2 text-sm">
                <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 break-words">{mail.subject}</span>
              </p>
              <MailState mail={mail} />
            </div>
            <p className="pl-6 text-xs break-words text-muted-foreground">
              To {[...mail.to, ...mail.cc].join(', ')} · {since(mail.sentAt ?? mail.createdAt)}
            </p>
            {mail.lastError && mail.status !== 'sent' && <p className="pl-6 text-xs break-words text-destructive">{mail.lastError}</p>}
            {mail.status !== 'sending' && (
              <div className="pl-4">
                <Button size="sm" variant="ghost" className="h-7" disabled={busy === mail.id} onClick={() => void resend(mail)}>
                  {busy === mail.id ? <Spinner /> : <RotateCw />} {mail.status === 'sent' ? 'Send a copy' : 'Send again'}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Where a message is, in a word with its icon — the colour is never alone. */
function MailState({ mail }: { mail: SentMail }) {
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '')
  const [tone, Icon, label] =
    mail.status === 'sent'
      ? (['border-success/25 bg-success-soft text-success', Check, 'Sent'] as const)
      : mail.status === 'failed'
        ? (['border-destructive/30 bg-destructive/5 text-destructive', TriangleAlert, 'Not sent'] as const)
        : mail.status === 'sending'
          ? (['border-info/25 bg-info-soft text-info', Clock, 'Sending'] as const)
          : (['border-warning/25 bg-warning-soft text-warning', Clock, mail.attempts > 0 ? `Retrying ${at(mail.nextAttemptAt)}` : 'Waiting'] as const)
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium [&_svg]:size-3 ${tone}`}>
      <Icon aria-hidden />
      {label}
    </span>
  )
}
