import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { requestsApi, type Target } from './api.ts'
import { checkState, CheckMessage, Field, FormActions, FormSection, ReasonField, RequestFormPage, ReviewPanel, SummaryItem, TeamField, Unreachable, useTeam, type Readiness, type Verdict } from './form-layout.tsx'
import { REQUEST_TYPES } from './kinds.ts'
import { TargetPath, WrappingUrl } from './status.tsx'


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

  // A link may carry the form filled in — the chatbot's drafts do.
  const [params] = useSearchParams()
  const [name, setName] = useState(params.get('name') ?? '')
  // Follows the name until someone types a key of their own.
  const [typedKey, setTypedKey] = useState<string | null>(params.get('key'))
  const key = typedKey ?? suggestKey(name)
  const [description, setDescription] = useState('')
  const [justification, setJustification] = useState(params.get('reason') ?? '')
  const [chosenTeam, setChosenTeam] = useState('')
  const team = useTeam(chosenTeam)
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

  const type = REQUEST_TYPES.find((t) => t.kind === 'create_jira_project')!
  const lead = 'A Jira software project for your team, created once someone in DevOps approves it.'
  if (server.error) {
    return <Unreachable type={type} lead={lead} message="Jira can’t be reached right now, so nothing can be checked." error={server.error} onRetry={server.reload} />
  }

  const browseUrl = server.data && key ? `${server.data.baseUrl}/browse/${encodeURIComponent(key)}` : null
  const ready: Readiness = [
    { label: 'Name given', done: name.trim() !== '', missing: 'Name the project.' },
    {
      label: 'Name and key available',
      done: verdict.state === 'done' && verdict.result.ok,
      missing: !key ? 'Give the project a key.' : verdict.state === 'done' ? 'Choose another name or key — that one can’t be used.' : 'Checking the name and key in Jira…',
    },
    { label: 'Team chosen', done: team !== '', missing: 'Choose the team that joins the project with you.' },
    { label: 'Reason given', done: justification.trim() !== '', missing: 'Say why you need it.' },
  ]

  return (
    <RequestFormPage
      type={type}
      lead={lead}
      onSubmit={submit}
      aside={
        <ReviewPanel
          ready={ready}
          steps={[
            'Someone in DevOps reviews it.',
            'The project is created in Jira, with you as its lead.',
            `You and ${team || 'your team'} join it as members.`,
            'The link appears on your request.',
          ]}
        >
          <SummaryItem label="You’re asking for">
            <TargetPath parts={[key || '…', name || '…']} className="block text-[15px]" />
          </SummaryItem>
          {key && (
            <SummaryItem label="Issues will be numbered">
              <code className="text-sm">
                {key}-1, {key}-2, …
              </code>
            </SummaryItem>
          )}
          {browseUrl && (
            <SummaryItem label="Where it will be">
              <code className="block text-xs">
                <WrappingUrl url={browseUrl} />
              </code>
            </SummaryItem>
          )}
        </ReviewPanel>
      }
    >
      <FormSection step={1} title="Project" description="Its name and key, checked against Jira as you type, and what it is for.">
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

        <Field label="Key" htmlFor="key" hint="Every issue is numbered with it, like LOAN-42. Suggested from the name; change it if you like.">
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
          <CheckMessage id="name-check" check={checkState(verdict, 'Checking Jira…', 'Available — no project has that name or key yet.')} />
        </Field>

        <Field label="Description" htmlFor="description" hint="Shown on the project in Jira." optional>
          <Textarea id="description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
        </Field>
      </FormSection>

      <FormSection step={2} title="Access" description="Who joins the project with you.">
        <TeamField value={team} onChange={setChosenTeam} hint="Joins the project with you. One of your groups in the directory." />
      </FormSection>

      <FormSection step={3} title="Justification" description="What DevOps reads before approving.">
        <ReasonField
          value={justification}
          onChange={setJustification}
          placeholder="e.g. Backlog for the loan scoring work, run by the Payments team."
          hint="Say who it is for and what work it will track."
        />
      </FormSection>

      <FormActions ready={ready} submitting={submitting} />
    </RequestFormPage>
  )
}
