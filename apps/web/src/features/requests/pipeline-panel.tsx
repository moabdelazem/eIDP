import { useState } from 'react'
import { Check, CircleDashed, Clock, ExternalLink, FileCode2, Loader2, PencilLine, RotateCcw, TriangleAlert, Undo2, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Facts, Section } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type PipelineFile, type PortalRequest, type RequestStep, type StepStatus } from './api.ts'

/**
 * A pipeline request's own part of its page: what was asked for — to
 * everyone who may see the request — then, to the people who may decide it,
 * the files approving would write, worked out from inventories as they are
 * now and editable while it waits; and once pushed, what runs in Jenkins
 * after it (provisioning, a first test build) and what is left to do by hand.
 * The requester never sees the files: reading them is the approver's job.
 */
export function PipelinePanel({ request: r, onChanged }: { request: PortalRequest; onChanged: () => void }) {
  const spec = r.pipeline
  if (!spec) return null
  return (
    <Section title="Pipeline">
      <Facts
        empty="—"
        items={[
          ['Application', <code>{spec.application}</code>],
          ['Build technology', `${spec.technology}${spec.version ? ` ${spec.version}` : ''}${spec.library ? ', a library' : ''}`],
          ['Deploy target', spec.deployTarget === 'OCP' ? 'OpenShift' : 'Kubernetes'],
          ...Object.entries(spec.fields).map(([name, value]) => [name.replaceAll('_', ' '), <code>{value}</code>] as [string, React.ReactNode]),
          ['Project in inventories', spec.newProject ? 'New — its team.yml and namespaces are written too' : 'Already there; reused'],
          ...(r.editedFiles.length ? ([['Files', `${r.editedFiles.length} edited by DevOps before approving`]] as [string, React.ReactNode][]) : []),
        ]}
      />
      {r.status === 'completed' && (
        <>
          <Steps request={r} onChanged={onChanged} />
          <ByHand request={r} />
        </>
      )}
      {r.canDecide && r.status !== 'completed' && r.status !== 'rejected' && r.status !== 'cancelled' && (
        <Files request={r} editable={r.status === 'pending'} onChanged={onChanged} />
      )}
    </Section>
  )
}

// ---- what approving writes ---------------------------------------------------------

function Files({ request: r, editable, onChanged }: { request: PortalRequest; editable: boolean; onChanged: () => void }) {
  // Keyed on the changes made so far: a renamed application writes other paths, so it is worked out again.
  const preview = useResource(['requests', 'pipeline', 'preview', r.id, r.adjustments.length], () => requestsApi.pipelinePreview(r.id))
  const [saving, setSaving] = useState<string | null>(null)
  if (preview.loading && !preview.data) return <Skeleton className="mt-4 h-24 w-full" />
  if (preview.error && !preview.data) {
    return (
      <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <TriangleAlert className="size-4" aria-hidden /> Could not work out the files: {preview.error}
      </p>
    )
  }
  const { files, manifests, errors, commit, edited } = preview.data!
  if (commit) return <p className="mt-4 text-sm text-muted-foreground">Already in inventories, in commit <code>{commit.slice(0, 10)}</code>.</p>

  // Every edit is sent each time: the API keeps exactly the set it is given.
  const edits = [...files, ...manifests].filter((f) => edited.includes(f.path))
  const saveEdits = async (path: string, next: PipelineFile[]) => {
    setSaving(path)
    try {
      await requestsApi.adjust(r.id, { files: next })
      preview.reload()
      onChanged()
      return true
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the edit. Try again.')
      return false
    } finally {
      setSaving(null)
    }
  }
  const actions = {
    editable,
    edited,
    saving,
    save: (file: PipelineFile) => saveEdits(file.path, [...edits.filter((e) => e.path !== file.path), file]),
    undo: (path: string) => saveEdits(path, edits.filter((e) => e.path !== path)),
  }

  return (
    <div className="mt-4 space-y-3">
      <h3 className="text-sm font-semibold">What approving writes to inventories</h3>
      {editable && (
        <p className="text-sm text-muted-foreground">
          Edit a file to change what is pushed — its content, not its place. Each edit is checked like a template (no credentials), and the requester sees which
          files you edited.
        </p>
      )}
      {errors.length > 0 && (
        <ul className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errors.map((error) => (
            <li key={error} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Would fail: </span>
                {error}
              </span>
            </li>
          ))}
        </ul>
      )}
      <FileList files={files} {...actions} />
      {manifests.length > 0 && (
        <>
          <h3 className="pt-2 text-sm font-semibold">…and its manifests to ocp-templates</h3>
          <FileList files={manifests} {...actions} />
        </>
      )}
    </div>
  )
}

function FileList({
  files,
  editable,
  edited,
  saving,
  save,
  undo,
}: {
  files: PipelineFile[]
  editable: boolean
  edited: string[]
  saving: string | null
  save: (file: PipelineFile) => Promise<boolean>
  undo: (path: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  return files.map((file) => {
    const isEdited = edited.includes(file.path)
    const open = editing === file.path
    return (
      <details key={file.path} className="rounded-md border" open={open || undefined}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <code className="min-w-0 flex-1 break-words">{file.path}</code>
          {isEdited && (
            <span className="inline-flex items-center gap-1 rounded-full border border-info/25 bg-info-soft px-2 py-0.5 text-xs text-info">
              <PencilLine className="size-3" aria-hidden /> Edited
            </span>
          )}
        </summary>
        {open ? (
          <div className="space-y-2 border-t p-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              aria-label={`Contents of ${file.path}`}
              className="min-h-48 font-mono text-xs"
              rows={Math.min(30, draft.split('\n').length + 2)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={saving === file.path || draft === file.content}
                onClick={async () => {
                  if (await save({ path: file.path, content: draft })) setEditing(null)
                }}
              >
                {saving === file.path ? <Spinner /> : <Check />} Save edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={saving === file.path}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <pre className="overflow-x-auto border-t bg-muted/40 p-3 text-xs">{file.content}</pre>
            {editable && (
              <div className="flex gap-2 border-t px-3 py-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(file.content)
                    setEditing(file.path)
                  }}
                >
                  <PencilLine /> Edit
                </Button>
                {isEdited && (
                  <Button size="sm" variant="ghost" disabled={saving === file.path} onClick={() => void undo(file.path)}>
                    {saving === file.path ? <Spinner /> : <Undo2 />} Back to the template’s
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </details>
    )
  })
}

// ---- after the push: Jenkins -----------------------------------------------------------

const STEP_NAME: Record<RequestStep['step'], string> = { provision: 'Provisioning', test: 'First test build' }

/** Each status with an icon and a word, never colour alone; red only where someone should act. */
const LOOK: Record<StepStatus, { icon: LucideIcon; word: string; tone: string; spin?: boolean }> = {
  waiting: { icon: Clock, word: 'Waiting', tone: 'text-muted-foreground' },
  pending: { icon: Loader2, word: 'Starting', tone: 'text-info', spin: true },
  queued: { icon: Loader2, word: 'Queued in Jenkins', tone: 'text-info', spin: true },
  running: { icon: Loader2, word: 'Running', tone: 'text-info', spin: true },
  succeeded: { icon: Check, word: 'Passed', tone: 'text-success' },
  failed: { icon: TriangleAlert, word: 'Failed', tone: 'text-destructive' },
  skipped: { icon: CircleDashed, word: 'Not run', tone: 'text-muted-foreground' },
}
const lookOf = (status: string) => LOOK[status as StepStatus] ?? { icon: CircleDashed, word: status, tone: 'text-muted-foreground' }

/**
 * What runs in Jenkins after the push — provisioning, then a first test build
 * — as it goes. The request is done either way: its files are in
 * inventories. A failed or skipped step is run again from here, by the people
 * who may decide the request; the test build can be started by hand while it
 * waits on a provisioning done outside the portal.
 */
function Steps({ request: r, onChanged }: { request: PortalRequest; onChanged: () => void }) {
  const { can } = useProfile()
  const [busy, setBusy] = useState<string | null>(null)
  if (r.steps.length === 0) return null
  const provision = r.steps.find((s) => s.step === 'provision')
  const run = async (step: RequestStep['step']) => {
    setBusy(step)
    try {
      await requestsApi.retryStep(r.id, step)
      toast.success(`${STEP_NAME[step]} is on its way to Jenkins.`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Jenkins could not be asked. Try again.')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="mt-4 space-y-2">
      <h3 className="text-sm font-semibold">After the push, in Jenkins</h3>
      <ul className="divide-y rounded-md border">
        {r.steps.map((s) => {
          const look = lookOf(s.status)
          const Icon = look.icon
          const again = s.status === 'failed' || s.status === 'skipped'
          const byHand = s.step === 'test' && s.status === 'waiting' && provision && ['failed', 'skipped'].includes(provision.status)
          return (
            <li key={s.step} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
              <Icon className={`mt-0.5 size-4 shrink-0 ${look.tone} ${look.spin ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p>
                  <span className="font-medium">{STEP_NAME[s.step] ?? s.step}</span> <span className={look.tone}>· {s.step === 'test' && s.status === 'waiting' ? 'Waits for provisioning' : look.word}</span>
                  {s.attempts > 1 && <span className="text-muted-foreground"> · try {s.attempts}</span>}
                </p>
                {s.job && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <code className="break-words">{s.job}</code>
                    {s.number !== null && (
                      <>
                        {' '}
                        #{s.number} ·{' '}
                        {can('jenkins.view') ? (
                          <Link className="underline underline-offset-2" to={`/jenkins/build?${new URLSearchParams({ job: s.job, number: String(s.number) })}`}>
                            Open the build
                          </Link>
                        ) : (
                          s.url && (
                            <a className="inline-flex items-center gap-1 underline underline-offset-2" href={s.url} target="_blank" rel="noreferrer">
                              Open in Jenkins <ExternalLink className="size-3" aria-hidden />
                            </a>
                          )
                        )}
                      </>
                    )}
                  </p>
                )}
                {s.note && <p className="mt-1 text-xs break-words text-muted-foreground">{s.note}</p>}
              </div>
              {r.canDecide && (again || byHand) && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(s.step)}>
                  {busy === s.step ? <Spinner /> : <RotateCcw />} {again ? 'Run again' : 'Run now'}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * What approval leaves to a person: the namespaces' tokens (and users left
 * empty), written as placeholders because a credential never goes into
 * inventories from the portal. Worked out from the request, so it is there
 * for as long as the request is. Provisioning is a step above when Jenkins
 * runs it, and says what to run by hand when it does not.
 */
function ByHand({ request: r }: { request: PortalRequest }) {
  const spec = r.pipeline!
  const namespaces = Object.entries(spec.newProject?.namespaces ?? {})
  if (namespaces.length === 0) return null
  const env = (key: string) => key.toUpperCase().replace('_', '-')
  return (
    <div className="mt-4 space-y-2">
      <h3 className="text-sm font-semibold">Still to do by hand</h3>
      <ul className="space-y-1 text-sm">
        {namespaces.map(([key, ns]) => (
          <li key={key} className="flex gap-2">
            <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              Set the token for <code>{ns.name}</code> ({env(key)}){ns.user ? '' : ', and its user'} in <code>host_vars/{key}_{spec.deployTarget === 'K8s' ? 'k8s' : 'ocp'}/vars.yml</code>.
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
