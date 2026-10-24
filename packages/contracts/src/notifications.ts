/** Email the portal sends: what `/requests/:id/emails` shows (apps/api modules/notifications). */

/**
 * Where a message is: waiting to be sent (`pending`, also between retries),
 * being handed to the mail server (`sending`), accepted by it (`sent`), or
 * given up on after every retry (`failed`).
 */
export type MailStatus = 'pending' | 'sending' | 'sent' | 'failed'

export type SentMail = {
  id: number
  /** What it is about, like `request.rejected`. */
  topic: string
  to: string[]
  cc: string[]
  subject: string
  status: MailStatus
  attempts: number
  /** The mail server's last refusal, when there was one. */
  lastError: string | null
  createdAt: string
  sentAt: string | null
  /** When the next try is due, while it waits to be retried. */
  nextAttemptAt: string | null
}
