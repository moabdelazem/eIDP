import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useSession } from '@/features/auth/session-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type AccessLevel, type Check as CheckResult, type Target } from './api.ts'
import { REQUEST_TYPES } from './kinds.ts'
import { Field } from './new-request-page.tsx'
import { ProjectPicker } from './project-picker.tsx'
import { TargetPath } from './status.tsx'

type Verdict = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: CheckResult }

const LEVELS: Record<AccessLevel, { label: string; detail: string }> = {
  read: { label: 'Read', detail: 'See and clone. Nothing can be pushed.' },
  contribute: {
    label: 'Contribute',
    detail: 'Push, branch, tag and work on pull requests. Not force-push, policies or permissions.',
  },
}

/** Login names, however they were typed: commas, spaces, one per line. */
function parseNames(text: string): string[] {
  const seen = new Map<string, string>()
  for (const name of text.split(/[\s,;]+/)) {
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
  }
  return [...seen.values()]
}

/**
 * Asking for access to something that already exists — a whole project, or
 * one repository in it — for yourself or for people you work with.
 */
export function GrantAccessPage() {
  const title = REQUEST_TYPES.find((type) => type.kind === 'grant_access')!.title
  usePageTitle(title)
  const navigate = useNavigate()
  const { session } = useSession()
  const collections = useResource(() => requestsApi.collections(), [])

  const [collection, setCollection] = useState('')
  const [project, setProject] = useState('')
  const [scope, setScope] = useState<'project' | 'repository'>('repository')
  const [repository, setRepository] = useState('')
  const [level, setLevel] = useState<AccessLevel>('contribute')
  // Most people ask for themselves; start there and let them add others.
  const [people, setPeople] = useState(session?.uid ?? '')
  const [justification, setJustification] = useState('')
  const [verdict, setVerdict] = useState<Verdict>({ state: 'idle' })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!collection && collections.data) setCollection(collections.data.defaultCollection)
  }, [collections.data, collection])

  const projects = useResource(
    () => (collection ? requestsApi.projects(collection) : Promise.resolve([])),
    [collection],
  )
  const repositories = useResource(
    () => (collection && project ? requestsApi.repositories(collection, project) : Promise.resolve([])),
    [collection, project],
  )

  const grantees = useMemo(() => parseNames(people), [people])
  const target: Target | null = useMemo(() => {
    if (!collection || !project || grantees.length === 0) return null
    if (scope === 'repository' && !repository) return null
    return {
      kind: 'grant_access',
      collection,
      project,
      ...(scope === 'repository' ? { repository } : {}),
      grantees,
      accessLevel: level,
    }
  }, [collection, project, scope, repository, grantees, level])

  // The same rules the API applies on submit, asked as they type.
  const checkKey = target ? JSON.stringify(target) : ''
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
        .catch(
          (err: unknown) =>
            !stale &&
            setVerdict({
              state: 'done',
              result: { ok: false, reason: err instanceof ApiError ? err.message : 'Could not check that.' },
            }),
        )
    }, 400)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // Keyed on the serialised target: the object is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey])

  const canSubmit =
    target !== null && verdict.state === 'done' && verdict.result.ok && justification.trim() !== '' && !submitting

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!target || !canSubmit) return
    setSubmitting(true)
    try {
      const created = await requestsApi.submit(target, justification)
      toast.success('Sent to DevOps for approval')
      navigate(`/requests/${created.id}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the request. Try again.')
      setSubmitting(false)
    }
  }

  if (collections.error) {
    return (
      <div className="max-w-prose">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
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

  const pathParts = [collection || '…', project || '…', ...(scope === 'repository' ? [repository || '…'] : [])]

  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-muted-foreground">
        Access to a project or repository that already exists, granted once someone in DevOps approves it.
      </p>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
        <form onSubmit={submit} className="space-y-6">
          <Field label="Collection" htmlFor="collection">
            {collections.loading ? (
              <Skeleton className="h-9 w-full" />
            ) : collections.data!.collections.length === 1 ? (
              <p id="collection" className="flex h-9 items-center font-mono text-sm">
                {collection}
              </p>
            ) : (
              <Select
                value={collection}
                onValueChange={(value) => {
                  setCollection(value)
                  setProject('')
                  setRepository('')
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

          <Field label="Project" htmlFor="project">
            <ProjectPicker
              id="project"
              projects={projects.data ?? []}
              value={project}
              onChange={(value) => {
                setProject(value)
                setRepository('')
              }}
              loading={!collection || projects.loading}
            />
          </Field>

          <Field label="Access to" htmlFor="scope">
            <ToggleGroup
              id="scope"
              type="single"
              variant="outline"
              value={scope}
              // Clicking the pressed item would clear it; one is always chosen.
              onValueChange={(value) => value && setScope(value as typeof scope)}
            >
              <ToggleGroupItem value="repository">One repository</ToggleGroupItem>
              <ToggleGroupItem value="project">The whole project</ToggleGroupItem>
            </ToggleGroup>
          </Field>

          {scope === 'repository' && (
            <Field label="Repository" htmlFor="repository">
              <ProjectPicker
                id="repository"
                noun="repository"
                projects={repositories.data ?? []}
                value={repository}
                onChange={setRepository}
                loading={!project || repositories.loading}
              />
            </Field>
          )}

          <Field label="Level" htmlFor="level" hint={LEVELS[level].detail}>
            <ToggleGroup
              id="level"
              type="single"
              variant="outline"
              value={level}
              onValueChange={(value) => value && setLevel(value as AccessLevel)}
            >
              {(Object.keys(LEVELS) as AccessLevel[]).map((key) => (
                <ToggleGroupItem key={key} value={key}>
                  {LEVELS[key].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field
            label="People"
            htmlFor="people"
            hint="Login names, separated by commas or spaces. For a whole team, ask for their group instead."
          >
            <Input
              id="people"
              value={people}
              onChange={(event) => setPeople(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-describedby="grant-check"
              aria-invalid={verdict.state === 'done' && !verdict.result.ok}
            />
            <GrantCheck id="grant-check" verdict={verdict} count={grantees.length} />
          </Field>

          <Field
            label="Why do you need it?"
            htmlFor="justification"
            hint="DevOps decides from this, so say what the access is for."
          >
            <Textarea
              id="justification"
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              placeholder="e.g. Joining the loan scoring team; I’ll be working on the API."
              rows={3}
              required
            />
          </Field>

          <Button type="submit" disabled={!canSubmit}>
            {submitting && <Spinner />}
            Send for approval
          </Button>
        </form>

        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-lg border bg-card p-5">
            <p className="text-sm text-muted-foreground">You’re asking for</p>
            <p className="mt-1 text-[15px] font-medium">{LEVELS[level].label} access to</p>
            <TargetPath parts={pathParts} className="mt-1 block text-[15px]" />
            <p className="mt-5 text-sm text-muted-foreground">For</p>
            {grantees.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">Nobody yet</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {grantees.map((name) => (
                  <li key={name} className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs">
                    {name}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-5 text-sm text-muted-foreground">Then</p>
            <ol className="mt-2 space-y-2 text-sm">
              {['Someone in DevOps reviews it.', 'Access is granted in Azure DevOps.', 'Your request shows it is done.'].map(
                (step, index) => (
                  <li key={step} className="flex gap-3">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ),
              )}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  )
}

function GrantCheck({ id, verdict, count }: { id: string; verdict: Verdict; count: number }) {
  if (verdict.state === 'idle') return <p id={id} className="sr-only" />
  if (verdict.state === 'checking') {
    return (
      <p id={id} className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Checking the directory and Azure DevOps…
      </p>
    )
  }
  return verdict.result.ok ? (
    <p id={id} className="flex items-center gap-1.5 text-sm" aria-live="polite">
      <Check className="size-3.5" /> {count === 1 ? 'Found in the directory.' : `All ${count} found in the directory.`}
    </p>
  ) : (
    <p id={id} className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {verdict.result.reason}
    </p>
  )
}
