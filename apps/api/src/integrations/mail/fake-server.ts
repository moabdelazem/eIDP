/**
 * A small stand-in for a mail server, for tests and for reading the portal's
 * mail locally without one:
 *
 *   pnpm --filter @eidp/api mail:fake
 *   MAIL_HOST=localhost MAIL_PORT=2525 MAIL_FROM="e-IDP <e-idp@eidp.local>"
 *
 * It speaks the part of SMTP nodemailer uses — greeting, EHLO, AUTH (PLAIN
 * and LOGIN), MAIL, RCPT, DATA, RSET, QUIT — without STARTTLS, and keeps each
 * message with its text and HTML decoded. Run on its own, it also serves them
 * at http://localhost:4061 to read in a browser. `refuse()` makes it turn
 * recipients or messages away, as a real server does.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

export type CapturedMail = {
  id: number
  from: string
  /** Every recipient of the envelope: To and Cc alike. */
  recipients: string[]
  subject: string
  /** The headers as sent, by lower-cased name. */
  headers: Record<string, string>
  text: string
  html: string
  receivedAt: string
}

type Refusal = 'recipients' | 'message' | null

export function createFakeMail(options: { username?: string; password?: string } = {}) {
  const messages: CapturedMail[] = []
  let refusal: Refusal = null

  const server: Server = createServer((socket) => session(socket))

  function session(socket: Socket) {
    let buffer = ''
    let from = ''
    let recipients: string[] = []
    let data: string[] | null = null
    let authStep: 'plain' | 'login-user' | 'login-pass' | null = null
    let user = ''
    const reply = (line: string) => socket.write(`${line}\r\n`)
    const authOk = (u: string, p: string) => !options.username || (u === options.username && p === options.password)

    reply('220 fake.eidp.local ESMTP ready')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let at: number
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        handle(line)
      }
    })
    socket.on('error', () => {})

    function handle(line: string) {
      if (data) {
        if (line === '.') {
          const raw = data.join('\r\n')
          data = null
          if (refusal === 'message') return reply('554 5.6.0 Message refused by the fake server')
          messages.push(parse(messages.length + 1, from, recipients, raw))
          reply(`250 2.0.0 Ok: queued as fake-${messages.length}`)
        } else data.push(line.startsWith('..') ? line.slice(1) : line)
        return
      }
      if (authStep) {
        const decoded = Buffer.from(line, 'base64').toString('utf8')
        if (authStep === 'plain') {
          const [, u = '', p = ''] = decoded.split('\0')
          authStep = null
          return reply(authOk(u, p) ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid')
        }
        if (authStep === 'login-user') {
          user = decoded
          authStep = 'login-pass'
          return reply('334 UGFzc3dvcmQ6')
        }
        authStep = null
        return reply(authOk(user, decoded) ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid')
      }
      const [verb = '', ...rest] = line.split(' ')
      const arg = rest.join(' ')
      switch (verb.toUpperCase()) {
        case 'EHLO':
        case 'HELO':
          return socket.write('250-fake.eidp.local\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 10485760\r\n')
        case 'AUTH': {
          const [mechanism = '', initial] = arg.split(' ')
          if (mechanism.toUpperCase() === 'PLAIN') {
            if (initial) {
              const [, u = '', p = ''] = Buffer.from(initial, 'base64').toString('utf8').split('\0')
              return reply(authOk(u, p) ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid')
            }
            authStep = 'plain'
            return reply('334 ')
          }
          if (mechanism.toUpperCase() === 'LOGIN') {
            authStep = 'login-user'
            return reply('334 VXNlcm5hbWU6')
          }
          return reply('504 5.5.4 Unrecognized authentication type')
        }
        case 'MAIL':
          from = /<([^>]*)>/.exec(arg)?.[1] ?? ''
          recipients = []
          return reply('250 2.1.0 Ok')
        case 'RCPT': {
          if (refusal === 'recipients') return reply('550 5.1.1 Recipient address rejected: User unknown')
          recipients.push(/<([^>]*)>/.exec(arg)?.[1] ?? '')
          return reply('250 2.1.5 Ok')
        }
        case 'DATA':
          if (recipients.length === 0) return reply('554 5.5.1 No valid recipients')
          data = []
          return reply('354 End data with <CR><LF>.<CR><LF>')
        case 'RSET':
          from = ''
          recipients = []
          return reply('250 2.0.0 Ok')
        case 'NOOP':
          return reply('250 2.0.0 Ok')
        case 'QUIT':
          reply('221 2.0.0 Bye')
          return socket.end()
        default:
          return reply('502 5.5.2 Command not recognized')
      }
    }
  }

  return {
    server,
    messages,
    /** Turn recipients or whole messages away from now on, or `null` to accept again. */
    refuse: (what: Refusal) => {
      refusal = what
    },
    /** Starts listening; port 0 picks a free one. Resolves to the port. */
    listen: (port = 0) =>
      new Promise<number>((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ---- reading what arrived ---------------------------------------------------

function parse(id: number, from: string, recipients: string[], raw: string): CapturedMail {
  const { headers, body } = split(raw)
  const parts = leaves(headers, body)
  const of = (type: string) => parts.find((p) => (p.headers['content-type'] ?? 'text/plain').startsWith(type))
  return {
    id,
    from,
    recipients,
    subject: decodeWords(headers.subject ?? ''),
    headers,
    text: of('text/plain')?.body ?? '',
    html: of('text/html')?.body ?? '',
    receivedAt: new Date().toISOString(),
  }
}

/** Headers (unfolded, by lower-cased name) and the body after the blank line. */
function split(raw: string): { headers: Record<string, string>; body: string } {
  const at = raw.indexOf('\r\n\r\n')
  const head = at >= 0 ? raw.slice(0, at) : raw
  const body = at >= 0 ? raw.slice(at + 4) : ''
  const headers: Record<string, string> = {}
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { headers, body }
}

/** The leaf parts of a message, each decoded from its transfer encoding. */
function leaves(headers: Record<string, string>, body: string): { headers: Record<string, string>; body: string }[] {
  const type = headers['content-type'] ?? 'text/plain'
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1]
  if (type.startsWith('multipart/') && boundary) {
    return body
      .split(`--${boundary}`)
      .slice(1)
      .filter((part) => !part.startsWith('--'))
      .flatMap((part) => {
        const inner = split(part.replace(/^\r\n/, ''))
        return leaves(inner.headers, inner.body.replace(/\r\n$/, ''))
      })
  }
  return [{ headers, body: decodeBody(body, headers['content-transfer-encoding'] ?? '7bit') }]
}

function decodeBody(body: string, encoding: string): string {
  if (/base64/i.test(encoding)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (/quoted-printable/i.test(encoding)) return decodeQuotedPrintable(body)
  return body
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = []
  const text = value.replace(/=\r\n/g, '')
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(...Buffer.from(text[i]!, 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** `=?UTF-8?Q?…?=` and `=?UTF-8?B?…?=` in a header, as text. */
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([QB])\?([^?]*)\?=\s*/gi, (_, _charset, kind: string, data: string) =>
    kind.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : decodeQuotedPrintable(data.replace(/_/g, ' ')),
  )
}

// ---- run on its own -----------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const smtpPort = Number(process.env.FAKE_MAIL_PORT ?? 2525)
  const httpPort = Number(process.env.FAKE_MAIL_HTTP_PORT ?? 4061)
  const fake = createFakeMail()
  await fake.listen(smtpPort)

  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const app = new Hono()
  app.get('/messages', (c) => c.json(fake.messages))
  app.get('/messages/:id', (c) => {
    const mail = fake.messages.find((m) => m.id === Number(c.req.param('id')))
    return mail ? c.html(mail.html || `<pre>${escape(mail.text)}</pre>`) : c.notFound()
  })
  app.get('/', (c) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>Fake mail</title>
<body style="font:14px system-ui;margin:24px;max-width:960px">
<h1 style="font-size:18px">Mail the portal sent (${fake.messages.length})</h1>
<table style="border-collapse:collapse;width:100%">${[...fake.messages]
      .reverse()
      .map(
        (m) => `<tr style="border-top:1px solid #ddd"><td style="padding:6px 8px;white-space:nowrap">${escape(m.receivedAt.slice(11, 19))}</td>
<td style="padding:6px 8px">${escape(m.recipients.join(', '))}</td>
<td style="padding:6px 8px"><a href="/messages/${m.id}">${escape(m.subject)}</a></td></tr>`,
      )
      .join('')}</table></body>`),
  )
  serve({ fetch: app.fetch, port: httpPort })
  console.log(`Fake mail server: SMTP on localhost:${smtpPort}, read it at http://localhost:${httpPort}`)
  console.log(`  MAIL_HOST=localhost MAIL_PORT=${smtpPort} MAIL_FROM="e-IDP <e-idp@eidp.local>"`)
}
