import { query } from './db.ts'
import type { Machine, Metrics } from './machines.ts'

/** A machine as the API returns it: its settings, and its latest sample. */
export type MachineView = Machine & {
  createdBy: string
  createdAt: string
  updatedBy: string | null
  updatedAt: string | null
  latest: { at: string; status: 'ok' | 'degraded' | 'down' | 'off'; summary: string; latencyMs: number | null; metrics: Metrics | null } | null
}

type Row = {
  id: string
  name: string
  host: string
  ports: number[]
  http_url: string | null
  exporter_url: string | null
  grp: string
  environment: string | null
  notify: string[]
  notes: string | null
  enabled: boolean
  created_by: string
  created_at: Date
  updated_by: string | null
  updated_at: Date | null
}

const toMachine = (r: Row): Machine => ({
  id: r.id,
  name: r.name,
  host: r.host,
  ports: r.ports,
  httpUrl: r.http_url,
  exporterUrl: r.exporter_url,
  group: r.grp,
  environment: r.environment,
  notify: r.notify,
  notes: r.notes,
  enabled: r.enabled,
})

export const componentOf = (id: string) => `machine:${id}`

export async function enabledMachines(): Promise<Machine[]> {
  const { rows } = await query<Row>('select * from health_machines where enabled order by grp, lower(name)')
  return rows.map(toMachine)
}

export async function listMachines(): Promise<MachineView[]> {
  const { rows } = await query<Row & { s_at: Date | null; s_status: MachineView['latest'] extends infer L ? (L extends { status: infer S } ? S : never) : never; s_summary: string | null; s_latency: number | null; s_metrics: Metrics | null }>(
    `select m.*, s.at as s_at, s.status as s_status, s.summary as s_summary, s.latency_ms as s_latency, s.metrics as s_metrics
       from health_machines m
       left join lateral (select * from health_samples where component = 'machine:' || m.id order by at desc limit 1) s on true
      order by m.grp, lower(m.name)`,
  )
  return rows.map((r) => ({
    ...toMachine(r),
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedBy: r.updated_by,
    updatedAt: r.updated_at?.toISOString() ?? null,
    latest: r.s_at ? { at: r.s_at.toISOString(), status: r.s_status, summary: r.s_summary ?? '', latencyMs: r.s_latency, metrics: r.s_metrics } : null,
  }))
}

export async function getMachine(id: string): Promise<Machine | null> {
  const { rows } = await query<Row>('select * from health_machines where id = $1', [id])
  return rows[0] ? toMachine(rows[0]) : null
}

export type MachineInput = Omit<Machine, 'id'>

async function audit(actor: string, action: 'add' | 'update' | 'remove', machine: Machine, previous: Machine | null) {
  await query('insert into health_machine_audit (actor, action, machine, previous) values ($1, $2, $3, $4)', [actor, action, machine, previous])
}

export async function addMachine(input: MachineInput, actor: string): Promise<Machine> {
  const { rows } = await query<Row>(
    `insert into health_machines (name, host, ports, http_url, exporter_url, grp, environment, notify, notes, enabled, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
    [input.name, input.host, input.ports, input.httpUrl, input.exporterUrl, input.group, input.environment, input.notify, input.notes, input.enabled, actor],
  )
  const machine = toMachine(rows[0]!)
  await audit(actor, 'add', machine, null)
  return machine
}

export async function updateMachine(id: string, input: MachineInput, actor: string): Promise<Machine | null> {
  const before = await getMachine(id)
  if (!before) return null
  const { rows } = await query<Row>(
    `update health_machines set name = $2, host = $3, ports = $4, http_url = $5, exporter_url = $6, grp = $7, environment = $8,
            notify = $9, notes = $10, enabled = $11, updated_by = $12, updated_at = now()
      where id = $1 returning *`,
    [id, input.name, input.host, input.ports, input.httpUrl, input.exporterUrl, input.group, input.environment, input.notify, input.notes, input.enabled, actor],
  )
  const machine = toMachine(rows[0]!)
  await audit(actor, 'update', machine, before)
  return machine
}

/** Gone from the list and from checking; its samples stay until they age out, so past incidents still read. */
export async function removeMachine(id: string, actor: string): Promise<boolean> {
  const before = await getMachine(id)
  if (!before) return false
  await query('delete from health_machines where id = $1', [id])
  await audit(actor, 'remove', before, null)
  return true
}

export type Sample = { component: string; name: string; status: 'ok' | 'degraded' | 'down' | 'off'; summary: string; latencyMs: number | null; metrics?: Metrics | null }

export async function recordSamples(at: Date, samples: Sample[]): Promise<void> {
  if (!samples.length) return
  await query(
    `insert into health_samples (at, component, name, status, latency_ms, summary, metrics)
     select $1, * from unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::jsonb[])`,
    [
      at,
      samples.map((s) => s.component),
      samples.map((s) => s.name),
      samples.map((s) => s.status),
      samples.map((s) => s.latencyMs),
      samples.map((s) => s.summary.slice(0, 500)),
      samples.map((s) => (s.metrics ? JSON.stringify(s.metrics) : null)),
    ],
  )
}
