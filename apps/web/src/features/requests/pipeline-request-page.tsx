import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type DeployTarget, type Namespace, type PipelineSpec, type ProjectTeams, type Target, type Technology } from './api.ts'
import { checkState, CheckMessage, Field, FormActions, FormSection, ReasonField, RequestFormPage, ReviewPanel, SummaryItem, TeamField, Unreachable, useTeam, type Readiness, type Verdict } from './form-layout.tsx'
import { REQUEST_TYPES } from './kinds.ts'
import { ProjectPicker } from './project-picker.tsx'
import { TargetPath } from './status.tsx'

/**
 * Asking for a pipeline: an application written into the inventories repo
 * for a repository that already exists. The technologies, their versions and
 * their fields come from the API's registry, so the form asks exactly what the
 * templates need; whether the project is new to inventories comes from the
 * catalog, and a new one is asked for its teams and namespaces. Nothing is
 * written until DevOps approve — and then from inventories as they are at
 * that moment.
 *
 * A link may carry ?collection=&project=&repository= — the repository is then
 * already chosen, as from a repository's own page.
 */

const TEAMS: ProjectTeams = {
  company: '',
  devTeam: '',
  qcTeam: '',
  uatTeam: '',
  prdTeam: '',
  automaticDeployToQc: null,
  devTeamList: [],
  opsTeamList: [],
  prdOnly: [],
  prdApprovers: [],
  projectManagers: [],
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

export function PipelineRequestPage() {
  const type = REQUEST_TYPES.find((t) => t.kind === 'create_pipeline')!
  usePageTitle(type.title)
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const collections = useResource(['requests', 'collections'], () => requestsApi.collections())
  const technologies = useResource(['requests', 'pipeline', 'technologies'], () => requestsApi.technologies())

  const [collection, setCollection] = useState(params.get('collection') ?? '')
  const [project, setProject] = useState(params.get('project') ?? '')
  const [repository, setRepository] = useState(params.get('repository') ?? '')
  // Follows the repository until someone names the application themselves.
  const [typedApplication, setTypedApplication] = useState<string | null>(null)
  const application = typedApplication ?? repository
  const [library, setLibrary] = useState(false)
  const [deployTarget, setDeployTarget] = useState<DeployTarget>('OCP')
  const [technologyKey, setTechnologyKey] = useState('')
  const [version, setVersion] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [teams, setTeams] = useState<ProjectTeams>(TEAMS)
  const [teamLists, setTeamLists] = useState({ devTeamList: '', opsTeamList: '', prdOnly: '', prdApprovers: '', projectManagers: '' })
  const [namespaces, setNamespaces] = useState<Record<string, Namespace>>({})
  const [justification, setJustification] = useState(params.get('reason') ?? '')
  const [chosenTeam, setChosenTeam] = useState('')
  const team = useTeam(chosenTeam)
  const [verdict, setVerdict] = useState<Verdict>({ state: 'idle' })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!collection && collections.data) setCollection(collections.data.defaultCollection)
  }, [collections.data, collection])

  const projects = useResource(collection ? ['requests', 'projects', collection] : ['requests', 'projects', 'none'], () => (collection ? requestsApi.projects(collection) : Promise.resolve([])))
  const repositories = useResource(collection && project ? ['requests', 'repositories', collection, project] : ['requests', 'repositories', 'none'], () =>
    collection && project ? requestsApi.repositories(collection, project) : Promise.resolve([]),
  )
  const inventory = useResource(project ? ['requests', 'pipeline', 'project', project.toLowerCase()] : ['requests', 'pipeline', 'project', 'none'], () =>
    project ? requestsApi.pipelineProject(project) : Promise.resolve(null),
  )

  const technology: Technology | undefined = technologies.data?.find((t) => t.key === technologyKey)
  // A technology's defaults, filled in once it is chosen — `{application}` follows the name.
  useEffect(() => {
    if (!technology) return
    setVersion((current) => (technology.versions.includes(current) ? current : (technology.versions[0] ?? '')))
    setFields((current) =>
      Object.fromEntries(technology.fields.map((f) => [f.name, current[f.name] ?? (f.options ? f.options[0] : (f.default ?? '').replaceAll('{application}', application))])),
    )
    if (!technology.targets.includes(deployTarget)) setDeployTarget(technology.targets[0]!)
    // the application name only seeds the defaults; editing it later does not overwrite a typed field
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [technology])

  const isNew = inventory.data ? !inventory.data.exists : false
  const environments = inventory.data?.environments[deployTarget] ?? []
  const needsNamespaces = isNew && technology !== undefined && !technology.noNamespaces

  const spec: PipelineSpec | null = useMemo(() => {
    if (!technology || !application) return null
    return {
      application,
      deployTarget,
      technology: technology.key,
      version: technology.versions.length ? version || null : null,
      library,
      fields,
      newProject: isNew
        ? {
            teams: { ...teams, ...Object.fromEntries(Object.entries(teamLists).map(([k, v]) => [k, lines(v)])) },
            namespaces: needsNamespaces ? Object.fromEntries(environments.map((env) => [env.key, namespaces[env.key] ?? { name: '', user: null }])) : {},
          }
        : null,
    }
  }, [technology, application, deployTarget, version, library, fields, isNew, teams, teamLists, needsNamespaces, environments, namespaces])

  const target: Target | null = useMemo(
    () => (collection && project && repository && spec ? { kind: 'create_pipeline', collection, project, repository, pipeline: spec } : null),
    [collection, project, repository, spec],
  )

  // The same rules the API applies on submit, asked as they fill it in.
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
        .catch((err: unknown) => !stale && setVerdict({ state: 'done', result: { ok: false, reason: err instanceof ApiError ? err.message : 'Could not check the pipeline.' } }))
    }, 500)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [target])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!target || !(verdict.state === 'done' && verdict.result.ok) || !justification.trim() || !team || submitting) return
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

  const lead = 'A build and deploy pipeline for an application, written into inventories once someone in DevOps approves it.'
  if (collections.error) {
    return <Unreachable type={type} lead={lead} message="Azure DevOps can’t be reached right now, so there is no repository to choose." error={collections.error} onRetry={collections.reload} />
  }
  if (technologies.error || technologies.data?.length === 0) {
    return (
      <Unreachable
        type={type}
        lead={lead}
        message="No build technologies are set up in the portal yet, so a pipeline can’t be asked for."
        error={technologies.error ?? 'The technology registry is empty.'}
        onRetry={technologies.reload}
      />
    )
  }

  const checked = verdict.state === 'done' && verdict.result.ok
  const ready: Readiness = [
    { label: 'Repository chosen', done: Boolean(collection && project && repository), missing: 'Choose the repository the application is built from.' },
    { label: 'Technology chosen', done: Boolean(technology), missing: 'Choose how it is built.' },
    {
      label: 'Pipeline possible',
      done: checked,
      missing: !target ? 'Name the application.' : verdict.state === 'done' && !verdict.result.ok ? verdict.result.reason : 'Checking the pipeline…',
    },
    { label: 'Team chosen', done: team !== '', missing: 'Choose your team.' },
    { label: 'Reason given', done: justification.trim() !== '', missing: 'Say why it is needed.' },
  ]
  const system = inventory.data?.system ?? project

  return (
    <RequestFormPage
      type={type}
      lead={lead}
      onSubmit={submit}
      aside={
        <ReviewPanel
          ready={ready}
          steps={[
            'Someone in DevOps reads the files it will write.',
            'They are pushed to inventories, checked against it as it is then.',
            'The commit appears on your request, and the application on the map.',
          ]}
        >
          <SummaryItem label="You’re asking for">
            <TargetPath parts={[collection || '…', project || '…', repository || '…']} className="block text-[15px]" />
          </SummaryItem>
          {application && (
            <SummaryItem label="Written to inventories at">
              <code className="block text-xs break-words">
                {system || '…'}/group_vars/{application}/
              </code>
            </SummaryItem>
          )}
          {technology && (
            <SummaryItem label="Built and deployed">
              <span className="text-sm">
                {technology.label}
                {version ? ` ${version}` : ''} on {deployTarget}
                {library ? ', as a library' : ''}
              </span>
            </SummaryItem>
          )}
        </ReviewPanel>
      }
    >
      <FormSection step={1} title="Repository" description="The repository the application is built from. It must already exist in Azure DevOps.">
        <Field label="Collection" htmlFor="collection">
          {collections.loading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <Select
              value={collection}
              onValueChange={(value) => {
                if (!value || value === collection) return
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
        <Field label="Repository" htmlFor="repository">
          <ProjectPicker
            id="repository"
            noun="repository"
            projects={(repositories.data ?? []).map((r) => ({ name: r.name, description: null }))}
            value={repository}
            onChange={setRepository}
            loading={!project || repositories.loading}
          />
        </Field>
      </FormSection>

      <FormSection step={2} title="Application" description="How it is named in inventories, built and deployed.">
        <Field label="Application name" htmlFor="application" hint="Its directory in inventories. The repository’s name unless the application is called something else.">
          <Input
            id="application"
            value={application}
            onChange={(event) => setTypedApplication(event.target.value.trim())}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-describedby="pipeline-check"
            aria-invalid={verdict.state === 'done' && !verdict.result.ok}
          />
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox id="library" checked={library} onCheckedChange={(value) => setLibrary(value === true)} />
          <label htmlFor="library" className="text-sm">
            A library — built and published, not deployed
          </label>
        </div>
        <Field label="Build technology" htmlFor="technology">
          {technologies.loading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <Select value={technologyKey} onValueChange={(value) => value && setTechnologyKey(value)}>
              <SelectTrigger id="technology" className="w-full">
                <SelectValue placeholder="Choose how it is built" />
              </SelectTrigger>
              <SelectContent>
                {technologies.data!.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {technology && (
          <>
            <Field label="Deploy target" htmlFor="target">
              <ToggleGroup
                id="target"
                type="single"
                variant="outline"
                size="sm"
                value={deployTarget}
                onValueChange={(value) => value && setDeployTarget(value as DeployTarget)}
                aria-label="Deploy target"
              >
                {(['OCP', 'K8s'] as const).map((t) => (
                  <ToggleGroupItem key={t} value={t} className="px-4" disabled={!technology.targets.includes(t)}>
                    {t === 'OCP' ? 'OpenShift' : 'Kubernetes'}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            {technology.versions.length > 0 && (
              <Field label={`${technology.label} version`} htmlFor="version" hint="Not listed? Type it.">
                <Input id="version" list="versions" value={version} onChange={(event) => setVersion(event.target.value.trim())} className="w-40 font-mono" autoComplete="off" />
                <datalist id="versions">
                  {technology.versions.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </Field>
            )}
            {technology.fields.map((f) => (
              <Field key={f.name} label={f.label} htmlFor={`field-${f.name}`} hint={f.help ?? undefined}>
                {f.options ? (
                  <Select value={fields[f.name] ?? ''} onValueChange={(value) => value && setFields((current) => ({ ...current, [f.name]: value }))}>
                    <SelectTrigger id={`field-${f.name}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`field-${f.name}`}
                    value={fields[f.name] ?? ''}
                    onChange={(event) => setFields((current) => ({ ...current, [f.name]: event.target.value }))}
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </Field>
            ))}
          </>
        )}
        <CheckMessage id="pipeline-check" check={checkState(verdict, 'Checking Azure DevOps, the registry and inventories…', 'Nothing in the way — this pipeline can be asked for.')} />
      </FormSection>

      <FormSection
        step={3}
        title="Project in inventories"
        description={!project ? 'Whether the project already has its files in inventories.' : isNew ? 'New to inventories: its teams and namespaces are written with the application.' : 'Already in inventories: its project files are reused as they are.'}
      >
        {!project ? (
          <p className="text-sm text-muted-foreground">Choose a project first.</p>
        ) : inventory.loading ? (
          <Skeleton className="h-9 w-full" />
        ) : !isNew ? (
          <p className="text-sm">
            <code>{inventory.data?.system}</code> already has its <code>team.yml</code> and namespaces.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['company', 'Company'],
                  ['devTeam', 'Dev team'],
                  ['qcTeam', 'QC team'],
                  ['uatTeam', 'UAT team'],
                  ['prdTeam', 'PRD team'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label} htmlFor={`team-${key}`}>
                  <Input id={`team-${key}`} value={teams[key]} onChange={(event) => setTeams((current) => ({ ...current, [key]: event.target.value }))} autoComplete="off" />
                </Field>
              ))}
              <Field label="Deploy to QC automatically" htmlFor="auto-qc">
                <Select
                  value={teams.automaticDeployToQc === null ? '' : String(teams.automaticDeployToQc)}
                  onValueChange={(value) => value && setTeams((current) => ({ ...current, automaticDeployToQc: value === 'true' }))}
                >
                  <SelectTrigger id="auto-qc" className="w-full">
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Yes</SelectItem>
                    <SelectItem value="false">No</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['devTeamList', 'Dev team list'],
                  ['opsTeamList', 'Ops team list'],
                  ['prdOnly', 'PRD only'],
                  ['prdApprovers', 'PRD approvers'],
                  ['projectManagers', 'Project managers'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label} htmlFor={`list-${key}`} hint="One per line." optional>
                  <Textarea id={`list-${key}`} rows={3} value={teamLists[key]} onChange={(event) => setTeamLists((current) => ({ ...current, [key]: event.target.value }))} />
                </Field>
              ))}
            </div>
            {needsNamespaces && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">Each environment’s namespace. Its token is written as a placeholder and set by DevOps.</p>
                {environments.map((env) => (
                  <div key={env.key} className="grid gap-4 sm:grid-cols-2">
                    <Field label={`${env.label} namespace`} htmlFor={`ns-${env.key}`}>
                      <Input
                        id={`ns-${env.key}`}
                        value={namespaces[env.key]?.name ?? ''}
                        onChange={(event) => setNamespaces((current) => ({ ...current, [env.key]: { name: event.target.value.trim(), user: current[env.key]?.user ?? null } }))}
                        className="font-mono"
                        autoComplete="off"
                      />
                    </Field>
                    <Field label={`${env.label} user`} htmlFor={`ns-user-${env.key}`} optional hint="Empty for the default user.">
                      <Input
                        id={`ns-user-${env.key}`}
                        value={namespaces[env.key]?.user ?? ''}
                        onChange={(event) => setNamespaces((current) => ({ ...current, [env.key]: { name: current[env.key]?.name ?? '', user: event.target.value.trim() || null } }))}
                        className="font-mono"
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </FormSection>

      <FormSection step={4} title="Team" description="Who the pipeline is for.">
        <TeamField value={team} onChange={setChosenTeam} hint="One of your groups in the directory." />
      </FormSection>

      <FormSection step={5} title="Justification" description="What DevOps reads before approving.">
        <ReasonField value={justification} onChange={setJustification} placeholder="e.g. Loan scoring API goes to QC next sprint; Payments owns it." hint="Say what the application is and who runs it." />
      </FormSection>

      <FormActions ready={ready} submitting={submitting} />
    </RequestFormPage>
  )
}
