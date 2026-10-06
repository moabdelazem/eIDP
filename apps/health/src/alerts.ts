import { config } from './config.ts'
import { query } from './db.ts'
import type { Sample } from './store.ts'

/**
 * The alert outbox. After each round, every component is judged against its
 * last `HEALTH_ALERT_AFTER` samples and its last alert:
 *
 * - **down** / **degraded** when that many samples in a row said so and no
 *   alert is open for it — one blip is not an outage — or when an open
 *   degraded alert gets worse;
 * - **recovered** when it is ok again and an alert is open.
 *
 * `off` (not configured) is never an alert. Nothing is sent from here: rows
 * wait in `health_alerts` as `pending` for the mail service, which claims them
 * with `for update skip locked` and marks them sent or failed.
 */

export type Alert = {
  id: string
  at: string
  component: string
  name: string
  kind: 'down' | 'degraded' | 'recovered'
  summary: string
  recipients: string[]
  state: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  lastError: string | null
  sentAt: string | null
}

export async function raiseAlerts(round: (Sample & { recipients?: string[] })[]): Promise<Alert[]> {
  const raised: Alert[] = []
  for (const s of round) {
    if (s.status === 'off') continue
    const [recent, last] = await Promise.all([
      query<{ status: string }>('select status from health_samples where component = $1 order by at desc, id desc limit $2', [s.component, config.HEALTH_ALERT_AFTER]),
      query<{ kind: Alert['kind'] }>('select kind from health_alerts where component = $1 order by at desc, id desc limit 1', [s.component]),
    ])
    const open = last.rows[0] && last.rows[0].kind !== 'recovered' ? last.rows[0].kind : null
    const bad = (status: string) => status === 'down' || status === 'degraded'

    let kind: Alert['kind'] | null = null
    if (bad(s.status)) {
      const run = recent.rows.length === config.HEALTH_ALERT_AFTER && recent.rows.every((r) => bad(r.status))
      const worst = recent.rows.every((r) => r.status === 'down') ? 'down' : 'degraded'
      if (run && (!open || (open === 'degraded' && worst === 'down'))) kind = worst
    } else if (s.status === 'ok' && open) {
      kind = 'recovered'
    }
    if (!kind) continue

    const recipients = [...new Set([...config.HEALTH_ALERT_TO, ...(s.recipients ?? [])].map((r) => r.toLowerCase()))]
    const summary = kind === 'recovered' ? `${s.name} is working again. ${s.summary}` : s.summary
    const { rows } = await query<AlertRow>(
      `insert into health_alerts (component, name, kind, summary, recipients) values ($1, $2, $3, $4, $5) returning *`,
      [s.component, s.name, kind, summary.slice(0, 1000), recipients],
    )
    raised.push(toAlert(rows[0]!))
  }
  return raised
}

type AlertRow = {
  id: string
  at: Date
  component: string
  name: string
  kind: Alert['kind']
  summary: string
  recipients: string[]
  state: Alert['state']
  attempts: number
  last_error: string | null
  sent_at: Date | null
}

const toAlert = (r: AlertRow): Alert => ({
  id: String(r.id),
  at: r.at.toISOString(),
  component: r.component,
  name: r.name,
  kind: r.kind,
  summary: r.summary,
  recipients: r.recipients,
  state: r.state,
  attempts: r.attempts,
  lastError: r.last_error,
  sentAt: r.sent_at?.toISOString() ?? null,
})

export async function listAlerts(limit = 100): Promise<{ alerts: Alert[]; pending: number }> {
  const [rows, pending] = await Promise.all([
    query<AlertRow>('select * from health_alerts order by at desc, id desc limit $1', [limit]),
    query<{ n: string }>(`select count(*) as n from health_alerts where state = 'pending'`),
  ])
  return { alerts: rows.rows.map(toAlert), pending: Number(pending.rows[0]?.n ?? 0) }
}
