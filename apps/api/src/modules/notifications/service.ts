import type { SentMail } from '@eidp/contracts/notifications'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { mailConfigured, parseAddresses, send } from '../../integrations/mail/index.ts'
import { config } from '../../lib/config.ts'
import { db, sqlRows } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { errorFields, log } from '../../lib/log.ts'
import { mailOutbox } from './schema.ts'

/**
 * Mail, through an outbox. A module queues a message (`enqueueMail`) and gets
 * on with its work; the `mail-outbox` job sends what is due, one process at a
 * time, and a refusal is retried with backoff before it is given up on. Every
 * message is kept, so the page it is about can show it and DevOps can send it
 * again — the old portal's Re-notify and Force notify, without the buttons
 * being the only way it ever went out.
 *
 * Unconfigured (no MAIL_HOST), nothing is queued: a backlog sent the day mail
 * is turned on would be weeks stale.
 */

/** Waits before each retry; after the last, the message is failed. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180]
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1
/** A message claimed this long ago and still `sending` belongs to a process that died. */
const STALE_CLAIM_MINUTES = 10

export type NewMail = {
  topic: string
  ref?: string
  to: string[]
  cc?: string[]
  subject: string
  text: string
  html: string
}

/**
 * Queues a message. Each address once; anyone in To is not copied again; a
 * message with nobody to send it to is not queued. Returns its id, or null
 * when nothing was queued.
 */
export async function enqueueMail(mail: NewMail): Promise<number | null> {
  if (!mailConfigured()) return null
  const to = parseAddresses(mail.to.join(','))
  const cc = parseAddresses((mail.cc ?? []).join(',')).filter((a) => !to.some((t) => t.toLowerCase() === a.toLowerCase()))
  if (to.length === 0 && cc.length === 0) return null
  const [row] = await db
    .insert(mailOutbox)
    .values({ topic: mail.topic, ref: mail.ref ?? null, to: to.length ? to : cc, cc: to.length ? cc : [], subject: mail.subject, textBody: mail.text, htmlBody: mail.html })
    .returning({ id: mailOutbox.id })
  // Addresses are people's: the log carries the topic and how many, not who.
  log.info('mail queued', { mail: row!.id, topic: mail.topic, ref: mail.ref, recipients: to.length + cc.length })
  return row!.id
}

/** DevOps' own address or list, from MAIL_DEVOPS_TO. */
export function devopsAddresses(): string[] {
  return parseAddresses(config.MAIL_DEVOPS_TO)
}

/** A page of the portal as a link for mail, or null when PORTAL_URL is not set. */
export function portalLink(path: string): string | null {
  return config.PORTAL_URL ? `${config.PORTAL_URL.replace(/\/+$/, '')}${path}` : null
}

/**
 * Sends what is due. Messages are claimed with `for update skip locked`, so
 * a second sender — another replica, or a retry asked for from a page — never
 * sends the same one. Returns how many went and how many failed for good.
 */
export async function sendDue(limit = 20): Promise<{ sent: number; failed: number }> {
  // A claim older than the stale limit was a process that died mid-send; the message is due again.
  await db
    .update(mailOutbox)
    .set({ status: 'pending', claimedAt: null })
    .where(and(eq(mailOutbox.status, 'sending'), lt(mailOutbox.claimedAt, sql`now() - make_interval(mins => ${STALE_CLAIM_MINUTES})`)))

  const claimed = await sqlRows<{ id: number }>(sql`
    update ${mailOutbox} set status = 'sending', claimed_at = now(), attempts = attempts + 1
     where id in (
       select id from ${mailOutbox}
        where status = 'pending' and next_attempt_at <= now()
        order by id
        limit ${limit}
        for update skip locked)
    returning id`)
  let sent = 0
  let failed = 0
  for (const { id } of claimed) {
    const [mail] = await db.select().from(mailOutbox).where(eq(mailOutbox.id, Number(id)))
    if (!mail) continue
    try {
      const { messageId } = await send({ to: mail.to, cc: mail.cc, subject: mail.subject, text: mail.textBody, html: mail.htmlBody })
      await db.update(mailOutbox).set({ status: 'sent', sentAt: sql`now()`, messageId, lastError: null, claimedAt: null }).where(eq(mailOutbox.id, mail.id))
      sent++
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500)
      const last = mail.attempts >= MAX_ATTEMPTS
      const wait = BACKOFF_MINUTES[Math.min(mail.attempts - 1, BACKOFF_MINUTES.length - 1)]!
      await db
        .update(mailOutbox)
        .set(last ? { status: 'failed', lastError: reason, claimedAt: null } : { status: 'pending', lastError: reason, claimedAt: null, nextAttemptAt: sql`now() + make_interval(mins => ${wait})` })
        .where(eq(mailOutbox.id, mail.id))
      if (last) failed++
      log.warn(last ? 'mail failed for good' : 'mail refused; will retry', { mail: mail.id, topic: mail.topic, attempts: mail.attempts, ...errorFields(err) })
    }
  }
  return { sent, failed }
}

function toSent(row: typeof mailOutbox.$inferSelect): SentMail {
  return {
    id: row.id,
    topic: row.topic,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    nextAttemptAt: row.status === 'pending' ? row.nextAttemptAt.toISOString() : null,
  }
}

/** Every message about one thing, newest first. */
export async function mailsAbout(ref: string): Promise<SentMail[]> {
  const rows = await db.select().from(mailOutbox).where(eq(mailOutbox.ref, ref)).orderBy(desc(mailOutbox.id)).limit(50)
  return rows.map(toSent)
}

/**
 * Sends a message about `ref` again: a failed one from the start of its
 * retries, a sent one as a fresh copy. The sender picks it up straight away.
 */
export async function resendMail(id: number, ref: string): Promise<SentMail> {
  const [row] = await db.select().from(mailOutbox).where(and(eq(mailOutbox.id, id), eq(mailOutbox.ref, ref)))
  if (!row) throw new ApiError(404, 'mail_not_found', 'There is no such email about this.')
  if (row.status === 'sending') throw new ApiError(409, 'mail_sending', 'That email is being sent right now.')
  let again: typeof mailOutbox.$inferSelect
  if (row.status === 'sent') {
    ;[again] = await db
      .insert(mailOutbox)
      .values({ topic: row.topic, ref: row.ref, to: row.to, cc: row.cc, subject: row.subject, textBody: row.textBody, htmlBody: row.htmlBody })
      .returning()
  } else {
    ;[again] = await db
      .update(mailOutbox)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: sql`now()` })
      .where(and(eq(mailOutbox.id, id), inArray(mailOutbox.status, ['pending', 'failed'])))
      .returning()
  }
  if (!again) throw new ApiError(409, 'mail_sending', 'That email is being sent right now.')
  void sendDue().catch((err) => log.warn('sending mail at once failed; the job will', { ...errorFields(err) }))
  return toSent(again)
}

// ---- what a message looks like ------------------------------------------------

export type EmailContent = {
  /** The one line that says what happened. */
  heading: string
  /** A sentence or two under it. */
  intro: string
  /** Label and value rows: what, where, who. */
  facts?: [label: string, value: string][]
  /** Someone's own words — a reason, a note — quoted as written. */
  quote?: { label: string; text: string } | null
  /** Where to go next. A null url (no PORTAL_URL) drops the button. */
  action?: { label: string; url: string | null } | null
  /** Why they are getting it. */
  footer: string
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * A message as plain text and as HTML, the same words in both. The HTML is
 * one narrow column of tables with inline styles — what mail clients, Outlook
 * among them, still render alike. No images and no remote fonts.
 */
export function renderEmail(content: EmailContent): { text: string; html: string } {
  const facts = content.facts ?? []
  const action = content.action?.url ? content.action : null
  const text = [
    content.heading,
    '',
    content.intro,
    ...(facts.length ? ['', ...facts.map(([label, value]) => `${label}: ${value}`)] : []),
    ...(content.quote ? ['', `${content.quote.label}:`, ...content.quote.text.split('\n').map((line) => `> ${line}`)] : []),
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    '',
    '—',
    content.footer,
  ].join('\n')

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f1f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3d7e6;border-radius:8px;font-family:Segoe UI,Arial,sans-serif;color:#251829">
<tr><td style="padding:20px 24px 0;font-size:12px;color:#6b5771">e-IDP</td></tr>
<tr><td style="padding:6px 24px 0;font-size:20px;font-weight:600;line-height:1.3">${escape(content.heading)}</td></tr>
<tr><td style="padding:10px 24px 0;font-size:14px;line-height:1.5">${escape(content.intro)}</td></tr>
${
  facts.length
    ? `<tr><td style="padding:16px 24px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5">${facts
        .map(([label, value]) => `<tr><td style="padding:2px 16px 2px 0;color:#6b5771;vertical-align:top;white-space:nowrap">${escape(label)}</td><td style="padding:2px 0;font-family:Consolas,Menlo,monospace;font-size:13px">${escape(value)}</td></tr>`)
        .join('')}</table></td></tr>`
    : ''
}
${
  content.quote
    ? `<tr><td style="padding:16px 24px 0"><div style="font-size:12px;color:#6b5771">${escape(content.quote.label)}</div><div style="margin-top:4px;padding:8px 12px;border-left:3px solid #7a4a85;background:#faf6fb;font-size:14px;line-height:1.5;white-space:pre-wrap">${escape(content.quote.text)}</div></td></tr>`
    : ''
}
${
  action
    ? `<tr><td style="padding:20px 24px 0"><a href="${escape(action.url!)}" style="display:inline-block;padding:9px 16px;border-radius:6px;background:#251829;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">${escape(action.label)}</a></td></tr>`
    : ''
}
<tr><td style="padding:20px 24px 20px;font-size:12px;line-height:1.5;color:#6b5771;border-top:0">${escape(content.footer)}</td></tr>
</table></td></tr></table></body></html>`
  return { text, html }
}
