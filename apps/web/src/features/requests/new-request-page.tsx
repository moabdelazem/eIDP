import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type RequestKind, type Target } from './api.ts'
import { REQUEST_TYPES } from './kinds.ts'
import { ProjectPicker } from './project-picker.tsx'
import { TargetPath, WrappingUrl } from './status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import {
  CheckMessage,
  Field,
  FormActions,
  FormSection,
  ReasonField,
  RequestFormPage,
  ReviewPanel,
  SummaryItem,
  TeamField,
  Unreachable,
  useTeam,
  checkState,
  type Readiness,
  type Verdict,
} from './form-layout.tsx'

// The title comes from kinds.ts, so the menu, the breadcrumb and this heading
// cannot drift apart; only the form's own wording lives here.
type CreationKind = Exclude<RequestKind, 'grant_access' | 'create_jira_project'>

const COPY: Record<CreationKind, { lead: string; noun: string; why: string }> = {
  create_repository: {
    lead: 'A Git repository in an existing project, created once someone in DevOps approves it.',
    noun: 'repository',
    why: 'e.g. New service for loan scoring, owned by the Payments team.',
  },
  create_project: {
    lead: 'A project with Git, in any collection, created once someone in DevOps approves it.',
    noun: 'project',
    why: 'e.g. Platform rewrite agreed in Q3 planning; repositories will follow.',
  },
}


export function NewRequestPage({ kind }: { kind: CreationKind }) {
  const copy = { ...COPY[kind], title: REQUEST_TYPES.find((type) => type.kind === kind)!.title }
  usePageTitle(copy.title)
  const navigate = useNavigate()
  const collections = useResource(() => requestsApi.collections(), [])

  // A link may carry the form filled in — the chatbot's drafts do.
  const [params] = useSearchParams()
  const [collection, setCollection] = useState(params.get('collection') ?? '')
  const [project, setProject] = useState(kind === 'create_repository' ? (params.get('project') ?? '') : '')
  const [name, setName] = useState((kind === 'create_repository' ? params.get('repository') : params.get('project')) ?? '')
  const [description, setDescription] = useState('')
  const [justification, setJustification] = useState(params.get('reason') ?? '')
  const [chosenTeam, setChosenTeam] = useState('')
  const team = useTeam(chosenTeam)
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

  // A prefilled project — a link's or the chatbot's — takes the spelling ADO uses.
  useEffect(() => {
    const exact = projects.data?.some((p) => p.name === project)
    const match = projects.data?.find((p) => p.name.toLowerCase() === project.toLowerCase())
    if (project && !exact && match) setProject(match.name)
  }, [projects.data, project])

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

  const type = REQUEST_TYPES.find((t) => t.kind === kind)!
  if (collections.error) {
    return (
      <Unreachable
        type={type}
        lead={copy.lead}
        message="Azure DevOps can’t be reached right now, so there is nothing to choose from."
        error={collections.error}
        onRetry={collections.reload}
      />
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
  const nameOk = verdict.state === 'done' && verdict.result.ok
  const ready: Readiness = [
    ...(kind === 'create_repository'
      ? [{ label: 'Project chosen', done: Boolean(collection && project), missing: 'Choose the project it goes in.' }]
      : [{ label: 'Collection chosen', done: Boolean(collection), missing: 'Choose a collection.' }]),
    {
      label: 'Name available',
      done: nameOk,
      missing: !name ? `Name the ${copy.noun}.` : verdict.state === 'done' ? `Choose another name — that one can’t be used.` : `Checking the ${copy.noun} name…`,
    },
    { label: 'Team chosen', done: team !== '', missing: 'Choose the team that gets access with you.' },
    { label: 'Reason given', done: justification.trim() !== '', missing: 'Say why you need it.' },
  ]

  return (
    <RequestFormPage
      type={type}
      lead={copy.lead}
      onSubmit={submit}
      aside={
        <ReviewPanel
          ready={ready}
          steps={[
            'Someone in DevOps reviews it.',
            `The ${copy.noun} is created for you in Azure DevOps.`,
            `You and ${team || 'your team'} get Contributor access to it.`,
            'The link appears on your request.',
          ]}
        >
          <SummaryItem label="You’re asking for">
            <TargetPath parts={pathParts} className="block text-[15px]" />
          </SummaryItem>
          {cloneUrl && (
            <SummaryItem label="Clone URL once created">
              <code className="block text-xs">
                <WrappingUrl url={cloneUrl} />
              </code>
            </SummaryItem>
          )}
        </ReviewPanel>
      }
    >
      <FormSection
        step={1}
        title="Location"
        description={kind === 'create_repository' ? 'The collection and the project the repository goes in.' : 'The collection the project goes in.'}
      >
        <Field label="Collection" htmlFor="collection">
          {collections.loading ? (
            <Skeleton className="h-9 w-full" />
          ) : collections.data!.collections.length === 1 ? (
            // One option is not a choice.
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

        {kind === 'create_repository' && (
          <Field label="Project" htmlFor="project">
            <ProjectPicker id="project" projects={projects.data ?? []} value={project} onChange={setProject} loading={!collection || projects.loading} />
          </Field>
        )}
      </FormSection>

      <FormSection
        step={2}
        title={kind === 'create_repository' ? 'Repository' : 'Project'}
        description={kind === 'create_repository' ? 'Its name, checked against Azure DevOps as you type.' : 'Its name, checked as you type, and what it is for.'}
      >
        <Field
          label={kind === 'create_repository' ? 'Repository name' : 'Project name'}
          htmlFor="name"
          hint={kind === 'create_repository' ? 'Lowercase with dashes, like loan-scoring-api.' : 'Usually the system name, like NBFS_LoanManagementSystem.'}
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
          <CheckMessage id="name-check" check={checkState(verdict, 'Checking Azure DevOps…', `Available — no ${copy.noun} by that name yet.`)} />
        </Field>

        {kind === 'create_project' && (
          <Field label="Description" htmlFor="description" hint="Shown on the project in Azure DevOps." optional>
            <Textarea id="description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
          </Field>
        )}
      </FormSection>

      <FormSection step={3} title="Access" description={`Who can work in the ${copy.noun} once it exists.`}>
        <TeamField value={team} onChange={setChosenTeam} hint={`Gets Contributor access to the ${copy.noun} with you. One of your groups in the directory.`} />
      </FormSection>

      <FormSection step={4} title="Justification" description="What DevOps reads before approving.">
        <ReasonField value={justification} onChange={setJustification} placeholder={copy.why} hint="Say who it is for and what it will hold." />
      </FormSection>

      <FormActions ready={ready} submitting={submitting} />
    </RequestFormPage>
  )
}
