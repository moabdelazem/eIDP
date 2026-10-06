import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api-client.ts'
import { systemApi, type Machine, type MachineInput } from './api.ts'

const list = (text: string) => text.split(/[\s,;]+/).filter(Boolean)

/**
 * Adding or changing a machine, in a panel beside the page. A machine is
 * checked by what it lists — ports, an HTTP URL, a node_exporter — so the
 * form asks for those, and says what each gives. Saved through the portal to
 * the health service, which validates it again and audits who did it; a new
 * machine is checked straight away, so the list shows its state at once.
 */
export function MachineSheet({
  machine,
  open,
  groups,
  onOpenChange,
  onSaved,
}: {
  /** The machine to change, or null to add one. */
  machine: Machine | null
  open: boolean
  groups: string[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [ports, setPorts] = useState('22')
  const [httpUrl, setHttpUrl] = useState('')
  const [exporterUrl, setExporterUrl] = useState('')
  const [group, setGroup] = useState('Servers')
  const [environment, setEnvironment] = useState('')
  const [notify, setNotify] = useState('')
  const [notes, setNotes] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(machine?.name ?? '')
    setHost(machine?.host ?? '')
    setPorts(machine ? machine.ports.join(', ') : '22')
    setHttpUrl(machine?.httpUrl ?? '')
    setExporterUrl(machine?.exporterUrl ?? '')
    setGroup(machine?.group ?? groups[0] ?? 'Servers')
    setEnvironment(machine?.environment ?? '')
    setNotify(machine?.notify.join(', ') ?? '')
    setNotes(machine?.notes ?? '')
    setEnabled(machine?.enabled ?? true)
    setError(null)
  }, [open, machine, groups])

  const portList = list(ports).map(Number)
  const badPort = portList.find((p) => !Number.isInteger(p) || p < 1 || p > 65535)

  async function save(event: FormEvent) {
    event.preventDefault()
    if (badPort !== undefined) return setError(`${list(ports).find((p) => Number(p) === badPort) ?? badPort} is not a port.`)
    const input: MachineInput = {
      name: name.trim(),
      host: host.trim(),
      ports: portList,
      httpUrl: httpUrl.trim() || null,
      exporterUrl: exporterUrl.trim() || null,
      group: group.trim() || 'Servers',
      environment: environment.trim() || null,
      notify: list(notify),
      notes: notes.trim() || null,
      enabled,
    }
    setSaving(true)
    setError(null)
    try {
      const saved = machine ? await systemApi.updateMachine(machine.id, input) : await systemApi.addMachine(input)
      // Checked now, so the row arrives with its state rather than "not checked yet".
      await systemApi.checkMachine(saved.id).catch(() => {})
      toast.success(machine ? `${saved.name} saved` : `${saved.name} added and checked`)
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'It could not be saved. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{machine ? `Change ${machine.name}` : 'Add a machine'}</SheetTitle>
          <SheetDescription>The health service checks it every few minutes, keeps its history, and raises an alert when it goes down.</SheetDescription>
        </SheetHeader>
        <form id="machine-form" onSubmit={save} className="flex-1 space-y-5 overflow-y-auto px-4 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="m-name">
              <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="jenkins-agent-01" required autoComplete="off" />
            </Field>
            <Field label="Host" htmlFor="m-host" hint="A hostname or an IP address.">
              <Input id="m-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="agent01.corp.local" className="font-mono" required autoComplete="off" spellCheck={false} />
            </Field>
          </div>

          <fieldset className="space-y-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">What to check</legend>
            <Field label="Ports" htmlFor="m-ports" hint="TCP ports that must answer, separated by commas — 22 for SSH, 5432 for Postgres. Leave empty if the URLs below are enough.">
              <Input id="m-ports" value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="22, 443" className="font-mono" autoComplete="off" />
            </Field>
            <Field label="HTTP URL" htmlFor="m-http" optional hint="Must answer with a status below 500 — a health or login page.">
              <Input id="m-http" value={httpUrl} onChange={(e) => setHttpUrl(e.target.value)} placeholder="https://agent01.corp.local/health" className="font-mono" autoComplete="off" />
            </Field>
            <Field
              label="node_exporter URL"
              htmlFor="m-exporter"
              optional
              hint={
                <>
                  Where Prometheus' node_exporter runs, for CPU, memory, disk, load and uptime.{' '}
                  {host.trim() && !exporterUrl && (
                    <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setExporterUrl(`http://${host.trim()}:9100/metrics`)}>
                      Use {host.trim()}:9100
                    </button>
                  )}
                </>
              }
            >
              <Input id="m-exporter" value={exporterUrl} onChange={(e) => setExporterUrl(e.target.value)} placeholder="http://agent01.corp.local:9100/metrics" className="font-mono" autoComplete="off" />
            </Field>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Group" htmlFor="m-group" hint="Machines are listed under it.">
              <Input id="m-group" value={group} onChange={(e) => setGroup(e.target.value)} list="machine-groups" placeholder="Jenkins agents" autoComplete="off" />
              <datalist id="machine-groups">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
            <Field label="Environment" htmlFor="m-env" optional>
              <Input id="m-env" value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="prd" autoComplete="off" />
            </Field>
          </div>

          <Field label="Also tell" htmlFor="m-notify" optional hint="Email addresses for this machine's alerts, beside the default list. Sent once the mail service exists.">
            <Input id="m-notify" value={notify} onChange={(e) => setNotify(e.target.value)} placeholder="payments-ops@corp.local" autoComplete="off" />
          </Field>
          <Field label="Notes" htmlFor="m-notes" optional>
            <Textarea id="m-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What runs on it, who to call." />
          </Field>
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} className="mt-0.5" />
            <span>
              Check it
              <span className="block text-xs text-muted-foreground">Off keeps it listed with its history, unchecked and unalerted — for maintenance.</span>
            </span>
          </label>
          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
        <SheetFooter className="flex-row justify-end gap-2 border-t">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="machine-form" disabled={saving || !name.trim() || !host.trim()}>
            {saving && <Spinner />}
            {machine ? 'Save' : 'Add and check'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, htmlFor, hint, optional = false, children }: { label: string; htmlFor: string; hint?: React.ReactNode; optional?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="gap-1.5">
        {label}
        {optional && <span className="text-xs font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
