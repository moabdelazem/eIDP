import { useState } from 'react'
import { BellRing, ChevronRight, CircleCheck, CircleX, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog.tsx'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since, WrappingUrl } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { systemApi, type Alert, type History, type Machine, type Metrics, type Status } from './api.ts'
import { MachineSheet } from './machine-sheet.tsx'
import { STATUS, UptimeBar } from './parts.tsx'

/** Past these a meter turns amber — the health service calls the machine degraded at the same marks. */
const LIMITS = { cpu: 0.95, memory: 0.95, disk: 0.9 }

/**
 * Our machines, a card per group (Jenkins agents, Databases…), each machine
 * a row like a component's: its state from the health service's last check,
 * its resources as meters where node_exporter gives them, the bar per day
 * below, and, opened, every port and URL it answered on. DevOps with
 * `machines.manage` add, change and remove them; anyone here can check one now.
 */
export function MachinesSection({ machines, history, error, onChanged }: { machines: Machine[] | undefined; history: History | undefined; error: string | null; onChanged: () => void }) {
  const { can } = useProfile()
  const manage = can('machines.manage')
  const [editing, setEditing] = useState<Machine | null>(null)
  const [sheet, setSheet] = useState(false)
  const groups = [...new Set((machines ?? []).map((m) => m.group))]
  const open = (m: Machine | null) => {
    setEditing(m)
    setSheet(true)
  }

  return (
    <section className="mt-10" aria-labelledby="machines">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="machines" className="text-lg font-semibold tracking-tight">
            Machines
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Checked by the health service on their ports, URLs and node_exporter.</p>
        </div>
        {manage && !error && (
          <Button size="sm" onClick={() => open(null)}>
            <Plus /> Add machine
          </Button>
        )}
      </div>

      {error ? (
        <p className="mt-4 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">{error}</p>
      ) : !machines ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl border bg-muted/30 motion-reduce:animate-none" />
      ) : machines.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <Server className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">No machines yet</p>
          <p className="max-w-md text-sm text-muted-foreground">Add the servers the portal and its teams depend on — Jenkins agents, databases, the OpenShift nodes — and they are checked every few minutes, with an alert when one goes down.</p>
          {manage && (
            <Button size="sm" onClick={() => open(null)}>
              <Plus /> Add the first one
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {groups.map((group) => (
            <section key={group} aria-label={group} className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-5 py-3">
                <h3 className="text-sm font-semibold">{group}</h3>
                <GroupCount machines={machines.filter((m) => m.group === group)} />
              </div>
              <ul className="divide-y">
                {machines
                  .filter((m) => m.group === group)
                  .map((m) => (
                    <MachineRow key={m.id} machine={m} history={history} manage={manage} onEdit={() => open(m)} onChanged={onChanged} />
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <MachineSheet machine={editing} open={sheet} groups={groups} onOpenChange={setSheet} onSaved={onChanged} />
    </section>
  )
}

function GroupCount({ machines }: { machines: Machine[] }) {
  const bad = machines.filter((m) => m.latest && (m.latest.status === 'down' || m.latest.status === 'degraded')).length
  return (
    <span className="text-xs font-normal text-muted-foreground">
      {machines.length} {machines.length === 1 ? 'machine' : 'machines'}
      {bad > 0 && <span className="text-warning"> · {bad} need a look</span>}
    </span>
  )
}

function MachineRow({ machine: m, history, manage, onEdit, onChanged }: { machine: Machine; history: History | undefined; manage: boolean; onEdit: () => void; onChanged: () => void }) {
  const status: Status | null = !m.enabled ? 'off' : (m.latest?.status ?? null)
  const [open, setOpen] = useState(status === 'down')
  const [checking, setChecking] = useState(false)
  const [removing, setRemoving] = useState(false)
  const past = history?.components[`machine:${m.id}`]
  const tone = status ? STATUS[status] : null
  const metrics = m.latest?.metrics ?? null

  async function check() {
    setChecking(true)
    try {
      const r = await systemApi.checkMachine(m.id)
      toast[r.status === 'ok' ? 'success' : 'warning'](`${m.name}: ${r.summary}`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'It could not be checked.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4 pb-3 text-left hover:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" aria-hidden />
          <Server className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="truncate font-medium">{m.name}</span>
              {m.environment && <span className="rounded border px-1.5 text-[11px] text-muted-foreground uppercase">{m.environment}</span>}
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">{m.host}</span>
          </span>
          {metrics && <Meters metrics={metrics} />}
          <span className={`flex shrink-0 items-center gap-1.5 text-sm font-medium ${tone?.text ?? 'text-muted-foreground'}`}>
            {tone ? (
              <>
                <tone.icon className="size-4" aria-hidden /> {m.enabled ? tone.label : 'Not checked'}
              </>
            ) : (
              'Not checked yet'
            )}
          </span>
        </CollapsibleTrigger>

        <div className="px-5 pb-4">{past ? <UptimeBar days={past.days} uptime={past.uptime} off={!m.enabled} /> : <div className="h-8 rounded bg-muted/50" />}</div>

        <CollapsibleContent className="border-t bg-muted/20 px-5 py-4">
          <div className="grid gap-5 text-sm md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="space-y-3">
              <p>
                {m.latest ? m.latest.summary : 'Not checked yet.'}
                {m.latest && <span className="text-muted-foreground"> · checked {since(m.latest.at)}</span>}
              </p>
              {metrics && <Answers metrics={metrics} machine={m} />}
              {m.notes && <p className="text-muted-foreground">{m.notes}</p>}
              <p className="text-xs text-muted-foreground">
                Alerts go to the default list{m.notify.length > 0 && <> and {m.notify.join(', ')}</>}. Added by {m.createdBy.split(' ')[0]}
                {m.updatedBy && <>, last changed by {m.updatedBy.split(' ')[0]}</>}.
              </p>
            </div>
            <div className="space-y-3">
              {metrics && <Resources metrics={metrics} />}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void check()} disabled={checking}>
                  {checking ? <Spinner /> : <RefreshCw />} Check now
                </Button>
                {manage && (
                  <>
                    <Button size="sm" variant="outline" onClick={onEdit}>
                      <Pencil /> Change
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
                      <Trash2 /> Remove
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Stop watching ${m.name}?`}
        confirm="Remove"
        destructive
        onConfirm={async () => {
          try {
            await systemApi.removeMachine(m.id)
            toast.success(`${m.name} removed`)
            onChanged()
            return true
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'It could not be removed.')
            return false
          }
        }}
      >
        It leaves the list and is no longer checked or alerted. Its past incidents stay in the history until they age out.
      </ConfirmDialog>
    </li>
  )
}

const pct = (n: number) => `${Math.round(n * 100)}%`

/** CPU, memory and disk as small meters beside the state — the glance a status row is for. */
function Meters({ metrics: x }: { metrics: Metrics }) {
  const items = [
    x.cpu !== null && { label: 'CPU', value: x.cpu, limit: LIMITS.cpu },
    x.memory !== null && { label: 'Mem', value: x.memory, limit: LIMITS.memory },
    x.disk && { label: 'Disk', value: x.disk.used, limit: LIMITS.disk },
  ].filter(Boolean) as { label: string; value: number; limit: number }[]
  if (!items.length) return null
  return (
    <span className="hidden shrink-0 items-center gap-3 md:flex" aria-label={items.map((i) => `${i.label} ${pct(i.value)}`).join(', ')}>
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums" aria-hidden>
          {i.label}
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
            <span className={`block h-full rounded-full ${i.value >= i.limit ? 'bg-warning' : 'bg-[var(--chart-1)]'}`} style={{ width: pct(Math.min(1, i.value)) }} />
          </span>
          <span className="w-8 text-right text-foreground">{pct(i.value)}</span>
        </span>
      ))}
    </span>
  )
}

/** Every port and URL, answered or not, with how fast. */
function Answers({ metrics: x, machine }: { metrics: Metrics; machine: Machine }) {
  const rows = [
    ...x.ports.map((p) => ({ what: `${machine.host}:${p.port}`, ok: p.ok, detail: p.ok ? `${p.ms} ms` : p.error })),
    ...(x.http ? [{ what: machine.httpUrl!, ok: x.http.ok, detail: x.http.ok ? `${x.http.status} · ${x.http.ms} ms` : x.http.error }] : []),
    ...(x.exporter ? [{ what: 'node_exporter', ok: x.exporter.ok, detail: x.exporter.ok ? 'read' : x.exporter.error }] : []),
  ]
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => (
        <li key={r.what} className="flex flex-wrap items-start gap-x-2">
          {r.ok ? <CircleCheck className="mt-px size-3.5 shrink-0 text-success" aria-label="Answered" /> : <CircleX className="mt-px size-3.5 shrink-0 text-destructive" aria-label="No answer" />}
          <span className="min-w-0 font-mono">
            <WrappingUrl url={r.what} />
          </span>
          <span className="ml-auto min-w-0 text-muted-foreground">{r.detail}</span>
        </li>
      ))}
    </ul>
  )
}

function Resources({ metrics: x }: { metrics: Metrics }) {
  const days = x.uptimeSeconds !== null ? Math.floor(x.uptimeSeconds / 86400) : null
  const facts = [
    x.cpu !== null && ['CPU', pct(x.cpu)],
    x.cores && ['Cores', String(x.cores)],
    x.load1 !== null && ['Load (1 min)', x.load1.toFixed(2)],
    x.memory !== null && ['Memory', pct(x.memory)],
    x.disk && ['Fullest disk', `${x.disk.mount} · ${pct(x.disk.used)}`],
    x.uptimeSeconds !== null && ['Up', days ? `${days} day${days === 1 ? '' : 's'}` : `${Math.round(x.uptimeSeconds / 3600)} h`],
  ].filter(Boolean) as [string, string][]
  if (!facts.length) return x.exporter ? null : <p className="text-xs text-muted-foreground">Add a node_exporter URL for CPU, memory, disk and uptime.</p>
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const ALERT_KIND = { down: { label: 'Down', tone: 'text-destructive' }, degraded: { label: 'Degraded', tone: 'text-warning' }, recovered: { label: 'Recovered', tone: 'text-success' } } as const
const ALERT_STATE = {
  pending: { label: 'Waiting for the mail service', tone: 'border-warning/30 bg-warning-soft text-warning' },
  sending: { label: 'Sending', tone: 'border-info/30 bg-info-soft text-info' },
  sent: { label: 'Sent', tone: 'border-success/30 bg-success-soft text-success' },
  failed: { label: 'Could not send', tone: 'border-destructive/30 bg-destructive/5 text-destructive' },
} as const

/**
 * The alert outbox: each time something went down, degraded or recovered —
 * after enough bad checks in a row that a blip is not an alert — with who
 * should hear. Nothing is sent yet: the mail service, when it exists, takes
 * them from here.
 */
export function AlertsSection({ data, error }: { data: { alerts: Alert[]; pending: number } | undefined; error: string | null }) {
  if (error) return null
  return (
    <section className="mt-10" aria-labelledby="alerts">
      <h2 id="alerts" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <BellRing className="size-5 text-muted-foreground" aria-hidden /> Alerts
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Raised by the health service when something stays down or degraded, and when it recovers. They wait here for the mail service, which will send them.
        {data && data.pending > 0 && <> {data.pending} waiting.</>}
      </p>
      {!data ? null : data.alerts.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No alerts yet.</p>
      ) : (
        <ul className="mt-4 divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
          {data.alerts.slice(0, 20).map((a) => (
            <li key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{a.name}</span>
                  <span className={`text-sm font-medium ${ALERT_KIND[a.kind].tone}`}>{ALERT_KIND[a.kind].label}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${ALERT_STATE[a.state].tone}`}>{ALERT_STATE[a.state].label}</span>
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{a.summary}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">To {a.recipients.length ? a.recipients.join(', ') : 'the default list'}</p>
              </div>
              <time dateTime={a.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(a.at).toLocaleString()}>
                {since(a.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
