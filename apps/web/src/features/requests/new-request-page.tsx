import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Check, Loader2, TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type Check as CheckResult, type RequestKind, type Target } from './api.ts'
import { ProjectPicker } from './project-picker.tsx'
import { TargetPath, WrappingUrl } from './status.tsx'

const COPY: Record<RequestKind, { title: string; lead: string; noun: string; why: string }> = {
  create_repository: {
    title: 'Ask for a repository',
    lead: 'It is created in Azure DevOps once someone in DEVOPS approves it.',
    noun: 'repository',
    why: 'e.g. New service for loan scoring, owned by the Payments team.',
  },
  create_project: {
    title: 'Ask for a project',
    lead: 'A new Azure DevOps project, with Git, created once DEVOPS approves it.',
    noun: 'project',
    why: 'e.g. Platform rewrite agreed in Q3 planning; repositories will follow.',
  },
}

type Verdict = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: CheckResult }

export function NewRequestPage({ kind }: { kind: RequestKind }) {
  const copy = COPY[kind]
  const navigate = useNavigate()
  const collections = useResource(() => requestsApi.collections(), [])

  const [collection, setCollection] = useState('')
  const [project, setProject] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [justification, setJustification] = useState('')
  const [verdict, setVerdict] = useState<Verdict>({ state: 'idle' })
  const [submitting, setSubmitting] = useState(false)

  // Start in the collection the portal already reads — usually the right one.
  useEffect(() => {
    if (!collection && collections.data) setCollection(collections.data.defaultCollection)
  }, [collections.data, collection])

  const projects = useResource(
    () => (collection && kind === 'create_repository' ? requestsApi.projects(collection) : Promise.resolve([])),
    [collection, kind],
  )

  const target: Target | null = useMemo(() => {
    if (!collection) return null
    if (kind === 'create_repository') {
      return project && name ? { kind, collection, project, repository: name } : null
    }
    return name ? { kind, collection, project: name, description } : null
  }, [kind, collection, project, name, description])

  // Ask the API as they type, with the same rules it applies on submit, so
  // what the form says is what will happen.
  useEffect(() => {
    if (!target) {
      setVerdict({ state: 'idle' })
      return
    }
    setVerdict({ state: 'checking' })
    let stale = false
    const timer = setTimeout(() => {
      requestsApi
        .check(target)
        .then((result) => !stale && setVerdict({ state: 'done', result }))
        .catch((err: unknown) =>
          !stale &&
          setVerdict({
            state: 'done',
            result: { ok: false, reason: err instanceof ApiError ? err.message : 'Could not check that name.' },
          }),
        )
    }, 400)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // description does not affect whether the name is available
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, collection, project, name])

  const canSubmit =
    target !== null && verdict.state === 'done' && verdict.result.ok && justification.trim() !== '' && !submitting

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!target || !canSubmit) return
    setSubmitting(true)
    try {
      const created = await requestsApi.submit(target, justification)
      toast.success('Sent to DEVOPS for approval')
      navigate(`/requests/${created.id}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the request. Try again.')
      setSubmitting(false)
    }
  }

  if (collections.error) {
    return (
      <div className="max-w-prose">
        <h1 className="text-lg font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-2 text-muted-foreground">
          Azure DevOps can’t be reached right now, so there is nothing to choose from.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{collections.error}</p>
        <Button variant="outline" className="mt-5" onClick={collections.reload}>
          Try again
        </Button>
      </div>
    )
  }

  const pathParts =
    kind === 'create_repository'
      ? [collection || '…', project || '…', name || '…']
      : [collection || '…', name || '…']
  const cloneUrl =
    kind === 'create_repository' && collections.data && project && name
      ? `${collections.data.serverUrl}/${encodeURIComponent(collection)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`
      : null

  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{copy.title}</h1>
      <p className="mt-1 text-muted-foreground">{copy.lead}</p>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
        <form onSubmit={submit} className="space-y-6">
          <Field label="Collection" htmlFor="collection">
            {collections.loading ? (
              <Skeleton className="h-9 w-full" />
            ) : collections.data!.collections.length === 1 ? (
              // One option is not a choice.
              <p id="collection" className="flex h-9 items-center font-mono text-sm">
                {collection}
              </p>
            ) : (
              <Select
                value={collection}
                onValueChange={(value) => {
                  setCollection(value)
                  setProject('')
                }}
              >
                <SelectTrigger id="collection" className="w-full">
                  <SelectValue placeholder="Choose a collection" />
                </SelectTrigger>
                <SelectContent>
                  {collections.data!.collections.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          {kind === 'create_repository' && (
            <Field label="Project" htmlFor="project">
              <ProjectPicker
                id="project"
                projects={projects.data ?? []}
                value={project}
                onChange={setProject}
                loading={!collection || projects.loading}
              />
            </Field>
          )}

          <Field
            label={kind === 'create_repository' ? 'Repository name' : 'Project name'}
            htmlFor="name"
            hint={
              kind === 'create_repository'
                ? 'Lowercase with dashes, like loan-scoring-api.'
                : 'Usually the system name, like NBFS_LoanManagementSystem.'
            }
          >
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-describedby="name-check"
              aria-invalid={verdict.state === 'done' && !verdict.result.ok}
            />
            <NameCheck id="name-check" verdict={verdict} noun={copy.noun} />
          </Field>

          {kind === 'create_project' && (
            <Field label="Description" htmlFor="description" hint="Shown on the project in Azure DevOps. Optional.">
              <Textarea
                id="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
              />
            </Field>
          )}

          <Field
            label="Why do you need it?"
            htmlFor="justification"
            hint="DEVOPS decides from this, so say who it is for and what it will hold."
          >
            <Textarea
              id="justification"
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              placeholder={copy.why}
              rows={3}
              required
            />
          </Field>

          <Button type="submit" disabled={!canSubmit}>
            {submitting && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            Send for approval
          </Button>
        </form>

        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-lg border bg-card p-5">
            <p className="text-sm text-muted-foreground">You’re asking for</p>
            <TargetPath parts={pathParts} className="mt-1 block text-[15px]" />

            {cloneUrl && (
              <>
                <p className="mt-5 text-sm text-muted-foreground">Clone URL once created</p>
                <code className="mt-1 block text-xs">
                  <WrappingUrl url={cloneUrl} />
                </code>
              </>
            )}

            <p className="mt-5 text-sm text-muted-foreground">Then</p>
            <ol className="mt-2 space-y-2 text-sm">
              {[
                'Someone in DEVOPS reviews it.',
                `The ${copy.noun} is created for you in Azure DevOps.`,
                'The link appears on your request.',
              ].map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function NameCheck({ id, verdict, noun }: { id: string; verdict: Verdict; noun: string }) {
  if (verdict.state === 'idle') return <p id={id} className="sr-only" />
  if (verdict.state === 'checking') {
    return (
      <p id={id} className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Checking Azure DevOps…
      </p>
    )
  }
  return verdict.result.ok ? (
    <p id={id} className="flex items-center gap-1.5 text-sm" aria-live="polite">
      <Check className="size-3.5" /> Available — no {noun} by that name yet.
    </p>
  ) : (
    <p id={id} className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {verdict.result.reason}
    </p>
  )
}
