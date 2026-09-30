import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { JiraIcon } from '@/components/brand-icons.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { requestsApi, type Check as CheckResult, type Target } from './api.ts'
import { REQUEST_TYPES } from './kinds.ts'
import { Field } from './new-request-page.tsx'
import { ProjectPicker } from './project-picker.tsx'
import { TargetPath, WrappingUrl } from './status.tsx'

type Verdict = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: CheckResult }

/**
 * A key the way Jira itself suggests one: the initials of a name of several
 * words, the start of a name of one. Only a suggestion — the key field is the
 * requester's to change, and Jira has the final say on it.
 */
function suggestKey(name: string): string {
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  const key = words.length > 1 ? words.map((word) => word[0]).join('') : (words[0] ?? '').slice(0, 4)
  return key.replace(/^[^A-Z]+/, '').slice(0, 10)
}

export function JiraProjectPage() {
  const title = REQUEST_TYPES.find((type) => type.kind === 'create_jira_project')!.title
  usePageTitle(title)
  const navigate = useNavigate()
  const server = useResource(() => requestsApi.jira(), [])

  const [name, setName] = useState('')
  // Follows the name until someone types a key of their own.
  const [typedKey, setTypedKey] = useState<string | null>(null)
  const key = typedKey ?? suggestKey(name)
  const [description, setDescription] = useState('')
  const [justification, setJustification] = useState('')
  const { profile, loaded: profileLoaded } = useProfile()
  const groups = profile?.groups ?? []
  const [chosenTeam, setChosenTeam] = useState('')
  // One group is not a choice.
  const team = chosenTeam || (groups.length === 1 ? groups[0]! : '')
  const [verdict, setVerdict] = useState<Verdict>({ state: 'idle' })
  const [submitting, setSubmitting] = useState(false)

  const target: Target | null = useMemo(
    () => (name && key ? { kind: 'create_jira_project', project: name, projectKey: key, description } : null),
    [name, key, description],
  )

  // The same rules the API applies on submit, including Jira's own opinion of
  // the key, asked as they type.
  useEffect(() => {
    if (!name || !key) {
      setVerdict({ state: 'idle' })
      return
    }
    setVerdict({ state: 'checking' })
    let stale = false
    const timer = setTimeout(() => {
      requestsApi
        .check({ kind: 'create_jira_project', project: name, projectKey: key })
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
  }, [name, key])

  const canSubmit =
    target !== null &&
    verdict.state === 'done' &&
    verdict.result.ok &&
    justification.trim() !== '' &&
    team !== '' &&
    !submitting

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!target || !canSubmit) return
    setSubmitting(true)
    try {
      const created = await requestsApi.submit(target, justification, team)
      toast.success('Sent to DevOps for approval')
      navigate(`/requests/${created.id}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the request. Try again.')
      setSubmitting(false)
    }
  }

  const heading = (
    <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      <JiraIcon className="size-5" />
      {title}
    </h1>
  )

  if (server.error) {
    return (
      <div className="max-w-prose">
        {heading}
        <p className="mt-2 text-muted-foreground">Jira can’t be reached right now, so nothing can be checked.</p>
        <p className="mt-2 text-sm text-muted-foreground">{server.error}</p>
        <Button variant="outline" className="mt-5" onClick={server.reload}>
          Try again
        </Button>
      </div>
    )
  }

  const browseUrl = server.data && key ? `${server.data.baseUrl}/browse/${encodeURIComponent(key)}` : null

  return (
    <div>
      {heading}
      <p className="mt-1 text-muted-foreground">
        A Jira software project for your team, created once someone in DevOps approves it.
      </p>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
        <form onSubmit={submit} className="space-y-6">
          <Field label="Project name" htmlFor="name" hint="What people will see in Jira, like Loan Scoring.">
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              aria-describedby="name-check"
              aria-invalid={verdict.state === 'done' && !verdict.result.ok}
            />
          </Field>

          <Field
            label="Key"
            htmlFor="key"
            hint="Every issue is numbered with it, like LOAN-42. Suggested from the name; change it if you like."
          >
            <Input
              id="key"
              value={key}
              // Keys are uppercase; typing lowercase is not a mistake worth an error.
              onChange={(event) => setTypedKey(event.target.value.toUpperCase().replace(/\s/g, ''))}
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              className="w-40 font-mono"
              aria-describedby="name-check"
              aria-invalid={verdict.state === 'done' && !verdict.result.ok}
            />
            <NameCheck id="name-check" verdict={verdict} />
          </Field>

          <Field label="Description" htmlFor="description" hint="Shown on the project in Jira. Optional.">
            <Textarea id="description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
          </Field>

          <Field label="Your team" htmlFor="team" hint="Joins the project with you. One of your groups in the directory.">
            {profileLoaded && groups.length === 0 ? (
              <p id="team" className="text-sm text-destructive">
                The directory has you in no groups, so there is no team to add. Ask for your account to be added to
                your team’s group, then come back.
              </p>
            ) : groups.length === 1 ? (
              <p id="team" className="flex h-9 items-center font-mono text-sm">
                {team}
              </p>
            ) : (
              <ProjectPicker
                id="team"
                noun="team"
                projects={groups.map((group) => ({ name: group, description: null }))}
                value={team}
                onChange={setChosenTeam}
                loading={!profileLoaded}
              />
            )}
          </Field>

          <Field
            label="Why do you need it?"
            htmlFor="justification"
            hint="DevOps decides from this, so say who it is for and what work it will track."
          >
            <Textarea
              id="justification"
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              placeholder="e.g. Backlog for the loan scoring work, run by the Payments team."
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
            <TargetPath parts={[key || '…', name || '…']} className="mt-1 block text-[15px]" />

            {key && (
              <>
                <p className="mt-5 text-sm text-muted-foreground">Issues will be numbered</p>
                <code className="mt-1 block text-sm">
                  {key}-1, {key}-2, …
                </code>
              </>
            )}

            {browseUrl && (
              <>
                <p className="mt-5 text-sm text-muted-foreground">Where it will be</p>
                <code className="mt-1 block text-xs">
                  <WrappingUrl url={browseUrl} />
                </code>
              </>
            )}

            <p className="mt-5 text-sm text-muted-foreground">Then</p>
            <ol className="mt-2 space-y-2 text-sm">
              {[
                'Someone in DevOps reviews it.',
                'The project is created in Jira, with you as its lead.',
                `You and ${team || 'your team'} join it as members.`,
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

function NameCheck({ id, verdict }: { id: string; verdict: Verdict }) {
  if (verdict.state === 'idle') return <p id={id} className="sr-only" />
  if (verdict.state === 'checking') {
    return (
      <p id={id} className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Checking Jira…
      </p>
    )
  }
  return verdict.result.ok ? (
    <p id={id} className="flex items-center gap-1.5 text-sm" aria-live="polite">
      <Check className="size-3.5" /> Available — no project has that name or key yet.
    </p>
  ) : (
    <p id={id} className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {verdict.result.reason}
    </p>
  )
}
