import { createTransport, type Mail } from 'nodemailer'
import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * SMTP through nodemailer — the one dependency here, because Node has no mail
 * client and SMTP is not one to write again (STARTTLS, auth, MIME, non-ASCII
 * names and subjects). Optional like the other integrations: unset, the
 * portal neither sends nor queues mail, and `mailConfig()` names what is
 * missing when something asks it to work.
 */

export type MailConfig = {
  host: string
  port: number
  /** Implicit TLS (465). Otherwise STARTTLS when the server offers it. */
  secure: boolean
  auth: { user: string; pass: string } | null
  from: string
}

export function mailConfig(): MailConfig {
  if (!config.MAIL_HOST) throw new ApiError(503, 'mail_not_configured', 'Email is not configured: MAIL_HOST is not set.')
  if (!config.MAIL_FROM) throw new ApiError(503, 'mail_not_configured', 'Email is not configured: set MAIL_FROM, like "e-IDP <e-idp@example.com>".')
  if (Boolean(config.MAIL_USERNAME) !== Boolean(config.MAIL_PASSWORD)) {
    throw new ApiError(503, 'mail_not_configured', 'Email is not configured: set both MAIL_USERNAME and MAIL_PASSWORD, or neither for a relay that needs no login.')
  }
  return {
    host: config.MAIL_HOST,
    port: config.MAIL_PORT,
    secure: config.MAIL_SECURE,
    auth: config.MAIL_USERNAME && config.MAIL_PASSWORD ? { user: config.MAIL_USERNAME, pass: config.MAIL_PASSWORD } : null,
    from: config.MAIL_FROM,
  }
}

/** Whether the portal sends mail at all. */
export function mailConfigured(): boolean {
  try {
    mailConfig()
    return true
  } catch {
    return false
  }
}

/** Addresses written as a list: commas, semicolons or spaces between them, each once. */
export function parseAddresses(value: string | undefined | null): string[] {
  const seen = new Map<string, string>()
  for (const raw of (value ?? '').split(/[,;\s]+/)) {
    const address = raw.trim()
    if (address.includes('@') && !seen.has(address.toLowerCase())) seen.set(address.toLowerCase(), address)
  }
  return [...seen.values()]
}

let transport: Mail | null = null

function transporter(): Mail {
  if (transport) return transport
  const mail = mailConfig()
  const timeout = config.HTTP_TIMEOUT_SECONDS * 1000
  transport = createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    ...(mail.auth ? { auth: mail.auth } : {}),
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  })
  return transport
}

export type OutgoingMail = { to: string[]; cc?: string[]; subject: string; text: string; html: string }

/**
 * Sends one message. A refusal comes back as an Error whose message is the
 * server's answer ("550 5.1.1 User unknown") — never the credentials, which
 * nodemailer does not put in its errors.
 */
export async function send(message: OutgoingMail): Promise<{ messageId: string }> {
  const info = await transporter().sendMail({
    from: mailConfig().from,
    to: message.to,
    cc: message.cc?.length ? message.cc : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
  })
  const rejected = (info as { rejected?: unknown[] }).rejected ?? []
  if (rejected.length > 0 && rejected.length >= message.to.length + (message.cc?.length ?? 0)) {
    throw new Error(`The mail server refused every recipient: ${rejected.map(String).join(', ')}`)
  }
  return { messageId: String((info as { messageId?: string }).messageId ?? '') }
}
