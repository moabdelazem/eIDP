import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/features/auth/session-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { parseNames, requestsApi, type Target } from './api.ts'
import { checkState, CheckMessage, Field, FormActions, FormSection, ReasonField, RequestFormPage, ReviewPanel, SummaryItem, Unreachable, type Readiness, type Verdict } from './form-layout.tsx'
import { REQUEST_TYPES } from './kinds.ts'
import { ProjectPicker } from './project-picker.tsx'
import { TargetPath } from './status.tsx'


/** Fixed, not chosen: what an access request always grants. */
const GRANTS =
  'Contribute on the whole project — its repositories, boards and pipelines, as a member of its Contributors group.'

/** And what a removal always takes away. */
const REMOVES = 'All their access to the project: they are taken out of its Contributors and Readers groups.'

/** The words that differ between giving access and taking it away. */
const COPY = {
  grant: {
    lead: 'Contribute access to a project that already exists, granted once someone in DevOps approves it.',
    projectHint: GRANTS,
    projectSection: 'The project to work in. Access is always the whole project.',
    peopleSection: 'Who gets access — you, others, or both. Each name is checked against the directory.',
    peopleHint: 'Separated by commas or spaces, up to 20. For a whole team, ask for their group instead.',
    summary: 'Contribute access to',
    noPeople: 'Name who should get access.',
    badPeople: 'Fix the names the directory doesn’t know.',
    checking: 'Checking the names in the directory…',
    found: (n: number) => (n === 1 ? 'Found in the directory.' : `All ${n} found in the directory.`),
    done: 'Access is granted in Azure DevOps.',
    why: 'Say what the access is for.',
    placeholder: 'e.g. Joining the loan scoring team; I’ll be working on the API.',
    reasonLabel: 'Why do you need it?',
    readyText: 'Ready. Nobody gets access until someone in DevOps approves it.',
  },
  revoke: {
    lead: 'Take people off a project they no longer work on, once someone in DevOps — or your team lead — approves it.',
    projectHint: REMOVES,
    projectSection: 'The project to take people off.',
    peopleSection: 'Who loses access. Each must have access to the project now.',
    peopleHint: 'Separated by commas or spaces, up to 20. A group’s name removes the whole group.',
    summary: 'Remove access to',
    noPeople: 'Name who should lose access.',
    badPeople: 'Fix the names: each must have access to the project now.',
    checking: 'Checking who has access…',
    found: (n: number) => (n === 1 ? 'Has access now, and can be removed.' : `All ${n} have access now, and can be removed.`),
    done: 'Access is removed in Azure DevOps.',
    why: 'Say why they no longer need it.',
    placeholder: 'e.g. Carol moved to the platform team in May.',
    reasonLabel: 'Why should they lose it?',
    readyText: 'Ready. Nobody loses access until it is approved.',
  },
}

/**
 * Asking for access to an existing project, for yourself or people you work
 * with — or, as `revoke`, for people to lose it. Access is always Contribute
 * on the whole project, and a removal always all of it; the only choices are
 * which project and who.
 */
export function GrantAccessPage({ mode = 'grant' }: { mode?: 'grant' | 'revoke' }) {
  const kind = mode === 'grant' ? 'grant_access' : 'revoke_access'
  const copy = COPY[mode]
  const title = REQUEST_TYPES.find((type) => type.kind === kind)!.title
  usePageTitle(title)
  const navigate = useNavigate()
  const { session } = useSession()
  const collections = useResource(['requests', 'collections'], () => requestsApi.collections())

  // A link may carry the form filled in — the chatbot's drafts do.
  const [params] = useSearchParams()
  const [collection, setCollection] = useState(params.get('collection') ?? '')
  const [project, setProject] = useState(params.get('project') ?? '')
  // Most people ask access for themselves; start there and let them add others. Nobody starts out removing themselves.
  // Joined with commas: the field is one line, and a browser drops line breaks from one.
  const [people, setPeople] = useState(params.get('people')?.split(',').join(', ') ?? (mode === 'grant' ? (session?.uid ?? '') : ''))
  const [justification, setJustification] = useState(params.get('reason') ?? '')
  const [verdict, setVerdict] = useState<Verdict>({ state: 'idle' })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!collection && collections.data) setCollection(collections.data.defaultCollection)
  }, [collections.data, collection])

  const projects = useResource(collection ? ['requests', 'projects', collection] : ['requests', 'projects', 'none'], () => (collection ? requestsApi.projects(collection) : Promise.resolve([])))

  // A prefilled project — a link's or the chatbot's — takes the spelling ADO uses.
  useEffect(() => {
    const exact = projects.data?.some((p) => p.name === project)
    const match = projects.data?.find((p) => p.name.toLowerCase() === project.toLowerCase())
    if (project && !exact && match) setProject(match.name)
  }, [projects.data, project])

  const grantees = useMemo(() => parseNames(people), [people])
  const target: Target | null = useMemo(
    () => (collection && project && grantees.length > 0 ? { kind, collection, project, grantees } : null),
    [kind, collection, project, grantees],
  )

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

  const type = REQUEST_TYPES.find((t) => t.kind === kind)!
  const lead = copy.lead
  if (collections.error) {
    return (
      <Unreachable
        type={type}
        lead={lead}
        message="Azure DevOps can’t be reached right now, so there is nothing to choose from."
        error={collections.error}
        onRetry={collections.reload}
      />
    )
  }

  const ready: Readiness = [
    { label: 'Project chosen', done: Boolean(collection && project), missing: 'Choose the project.' },
    {
      label: mode === 'grant' ? 'People found' : 'People with access',
      done: grantees.length > 0 && verdict.state === 'done' && verdict.result.ok,
      missing: grantees.length === 0 ? copy.noPeople : verdict.state === 'done' ? copy.badPeople : copy.checking,
    },
    { label: 'Reason given', done: justification.trim() !== '', missing: copy.why },
  ]

  return (
    <RequestFormPage
      type={type}
      lead={lead}
      onSubmit={submit}
      aside={
        <ReviewPanel ready={ready} steps={['Someone in DevOps reviews it.', copy.done, 'Your request shows it is done.']}>
          <SummaryItem label={copy.summary}>
            <TargetPath parts={[collection || '…', project || '…']} className="block text-[15px]" />
          </SummaryItem>
          <SummaryItem label={grantees.length > 1 ? `For ${grantees.length} people` : 'For'}>
            {grantees.length === 0 ? (
              <span className="text-muted-foreground">Nobody yet</span>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {grantees.map((name) => (
                  <li key={name} className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </SummaryItem>
        </ReviewPanel>
      }
    >
      <FormSection step={1} title="Project" description={copy.projectSection}>
        <Field label="Collection" htmlFor="collection">
          {collections.loading ? (
            <Skeleton className="h-9 w-full" />
          ) : collections.data!.collections.length === 1 ? (
            <p id="collection" className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm">
              {collection}
            </p>
          ) : (
            <Select
              value={collection}
              onValueChange={(value) => {
                // Radix also calls this while it settles on its first value; only a real change of collection empties the project.
                if (!value || value === collection) return
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

        <Field label="Project" htmlFor="project" hint={copy.projectHint}>
          <ProjectPicker id="project" projects={projects.data ?? []} value={project} onChange={setProject} loading={projects.loading} after={!collection ? 'a collection' : undefined} />
        </Field>
      </FormSection>

      <FormSection step={2} title="People" description={copy.peopleSection}>
        <Field label="Login names" htmlFor="people" hint={copy.peopleHint}>
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
          <CheckMessage
            id="grant-check"
            check={checkState(verdict, mode === 'grant' ? 'Checking the directory and Azure DevOps…' : 'Checking who has access…', copy.found(grantees.length))}
          />
        </Field>
      </FormSection>

      <FormSection step={3} title="Justification" description="What DevOps reads before approving.">
        <ReasonField
          value={justification}
          onChange={setJustification}
          placeholder={copy.placeholder}
          hint={copy.why}
          label={copy.reasonLabel}
        />
      </FormSection>

      <FormActions ready={ready} submitting={submitting} readyText={copy.readyText} />
    </RequestFormPage>
  )
}
