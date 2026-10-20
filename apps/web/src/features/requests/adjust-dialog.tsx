import { useState } from 'react'
import { PencilLine, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type PortalRequest, type RequestChanges } from './api.ts'

type Field = { key: Exclude<keyof RequestChanges, 'files'>; label: string; mono?: boolean }

/** What a decider may change, by kind — the API's list (modules/requests/adjust.ts). Access requests change nothing. */
const FIELDS: Partial<Record<PortalRequest['kind'], Field[]>> = {
  create_repository: [
    { key: 'collection', label: 'Collection' },
    { key: 'project', label: 'Project' },
    { key: 'repository', label: 'Repository', mono: true },
  ],
  create_project: [
    { key: 'collection', label: 'Collection' },
    { key: 'project', label: 'Project' },
  ],
  create_jira_project: [
    { key: 'project', label: 'Project name' },
    { key: 'projectKey', label: 'Project key', mono: true },
  ],
  create_pipeline: [
    { key: 'application', label: 'Application', mono: true },
    { key: 'version', label: 'Version' },
  ],
}

export const canAdjust = (r: PortalRequest) => Boolean(r.canDecide && r.status === 'pending' && FIELDS[r.kind])

function current(r: PortalRequest, key: Field['key']): string {
  if (key === 'application') return r.pipeline?.application ?? ''
  if (key === 'version') return r.pipeline?.version ?? ''
  return r[key] ?? ''
}

/**
 * Change a waiting request instead of rejecting it to be filed again: a
 * name that breaks a convention, a version, a key. Each change is checked as
 * a new request would be — the dialog stays open with the reason when it is
 * refused — and the requester sees what was changed and by whom. A
 * pipeline's files are edited where they are read, under "What approving
 * writes".
 */
export function AdjustDialog({ request: r, onChanged }: { request: PortalRequest; onChanged: () => void }) {
  const fields = FIELDS[r.kind] ?? []
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pipeline = r.kind === 'create_pipeline'
  // The versions the technology builds, so the version is chosen, not typed.
  const technologies = useResource(['requests', 'pipeline', 'technologies'], () => (pipeline ? requestsApi.technologies() : Promise.resolve([])))
  const versions = technologies.data?.find((t) => t.key === r.pipeline?.technology)?.versions ?? []

  const start = (next: boolean) => {
    if (next) setValues(Object.fromEntries(fields.map((f) => [f.key, current(r, f.key)])))
    setError(null)
    setOpen(next)
  }
  // Only what was opened and changed; the fields hold nothing until the dialog opens.
  const changes = Object.fromEntries(
    fields.flatMap((f) => {
      const value = values[f.key]?.trim()
      return value !== undefined && value !== current(r, f.key) ? [[f.key, value]] : []
    }),
  ) as RequestChanges

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await requestsApi.adjust(r.id, changes)
      toast.success(`Changed. ${r.requestedByName} sees what you changed.`)
      setOpen(false)
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the change. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={start}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilLine /> Adjust
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust before approving</DialogTitle>
          <DialogDescription>
            Fix what is asked for instead of rejecting it to be filed again. Each change is checked as a new request would be, and {r.requestedByName} sees
            what you changed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {fields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`adjust-${field.key}`}>{field.label}</Label>
              {field.key === 'version' && versions.length > 0 ? (
                <Select value={values.version ?? ''} onValueChange={(v) => setValues((all) => ({ ...all, version: v }))}>
                  <SelectTrigger id="adjust-version" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`adjust-${field.key}`}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues((all) => ({ ...all, [field.key]: e.target.value }))}
                  className={field.mono ? 'font-mono' : ''}
                  autoComplete="off"
                />
              )}
              {field.key in changes && (
                <p className="text-xs text-muted-foreground">
                  Asked for: <span className={field.mono ? 'font-mono' : ''}>{current(r, field.key) || '—'}</span>
                </p>
              )}
            </div>
          ))}
          {pipeline && r.editedFiles.length > 0 && (
            <p className="text-xs text-muted-foreground">Renaming the application sets aside your edits to its files: their paths change.</p>
          )}
          {error && (
            <p role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Not changed: </span>
                {error}
              </span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => start(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || Object.keys(changes).length === 0}>
            {saving ? <Spinner /> : null} Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
