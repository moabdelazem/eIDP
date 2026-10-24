import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { TriangleAlert } from 'lucide-react'
import { AzureDevOpsIcon, JiraIcon } from '@/components/brand-icons.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useSession } from '@/features/auth/session-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { parseNames, requestsApi, type Target } from './api.ts'
import {
  checkState,
  CheckMessage,
  Field,
  FormActions,
  FormSection,
  ReasonField,
  RequestFormPage,
  ReviewPanel,
  SummaryItem,
  TeamField,
  useTeam,
  type Readiness,
  type Verdict,
} from './form-layout.tsx'
import { REQUEST_TYPES, type ProviderId } from './kinds.ts'
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

/**
 * Asks the API, as they type, whether `target` could be filed — the same
 * rules it applies on submit. Idle while there is nothing to ask.
 */
function useCheck(target: Target | null): Verdict {
  const [verdict, setVerdict] = useState<Verdict>({ state: 'idle' })
  const key = target ? JSON.stringify(target) : ''
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
        .catch((err: unknown) => !stale && setVerdict({ state: 'done', result: { ok: false, reason: err instanceof ApiError ? err.message : 'Could not check that.' } }))
    }, 400)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // The target's content, not its identity: a new object with the same fields is the same question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return verdict
}

/**
 * A new project, in Azure DevOps, in Jira, or both — the old portal's
 * "Request New DevOps Project". It opens from either system's Project in the
 * New request menu with that system ticked; the other is one tick away. One
 * name and description for both, and each system's own details beside it:
 * the collection and the developers who get Contributor in Azure DevOps, the
 * key and the lead in Jira. Sending files one request per system, together
 * or not at all; DevOps decide each on its own.
 */
export function ProjectRequestPage({ start }: { start: ProviderId }) {
  const navigate = useNavigate()
  const { session } = useSession()
  const [params] = useSearchParams()

  const [inAdo, setInAdo] = useState(start !== 'jira' || params.get('also') === 'azure-devops')
  const [inJira, setInJira] = useState(start === 'jira' || params.get('also') === 'jira')
  // A link may carry the form filled in — the chatbot's drafts do (Azure DevOps' as `project`, Jira's as `name`).
  const [name, setName] = useState(params.get('project') ?? params.get('name') ?? '')
  const [description, setDescription] = useState('')
  const [collection, setCollection] = useState(params.get('collection') ?? '')
  const [developersText, setDevelopersText] = useState('')
  // Follows the name until someone types a key of their own.
  const [typedKey, setTypedKey] = useState<string | null>(params.get('key'))
  const key = typedKey ?? suggestKey(name)
  const [lead, setLead] = useState('')
  const [justification, setJustification] = useState(params.get('reason') ?? '')
  const [chosenTeam, setChosenTeam] = useState('')
  const team = useTeam(chosenTeam)
  const [submitting, setSubmitting] = useState(false)

  const where: ProviderId[] = [...(inAdo ? (['azure-devops'] as const) : []), ...(inJira ? (['jira'] as const) : [])]
  const title = inAdo && inJira ? 'New project in Azure DevOps and Jira' : inJira ? 'New Jira project' : 'New Azure DevOps project'
  usePageTitle(title)

  // Each system is asked only once it is ticked: an unreachable Jira does not stop an Azure DevOps request.
  const collections = useResource(inAdo ? ['requests', 'collections'] : ['requests', 'collections', 'off'], () => (inAdo ? requestsApi.collections() : Promise.resolve(null)))
  const jira = useResource(inJira ? ['requests', 'jira'] : ['requests', 'jira', 'off'], () => (inJira ? requestsApi.jira() : Promise.resolve(null)))

  // Start in the collection the portal already reads — usually the right one.
  useEffect(() => {
    if (!collection && collections.data) setCollection(collections.data.defaultCollection)
  }, [collections.data, collection])

  const developers = useMemo(() => parseNames(developersText), [developersText])
  const leadName = lead.trim()

  const adoTarget: Target | null = useMemo(
    () => (inAdo && collection && name ? { kind: 'create_project', collection, project: name, developers } : null),
    [inAdo, collection, name, developers],
  )
  const jiraTarget: Target | null = useMemo(
    () => (inJira && name && key ? { kind: 'create_jira_project', project: name, projectKey: key, ...(leadName ? { lead: leadName } : {}) } : null),
    [inJira, name, key, leadName],
  )
  const adoVerdict = useCheck(adoTarget)
  const jiraVerdict = useCheck(jiraTarget)
  const passed = (verdict: Verdict) => verdict.state === 'done' && verdict.result.ok

  const ready: Readiness = [
    { label: 'Where it goes', done: inAdo || inJira, missing: 'Choose Azure DevOps, Jira, or both.' },
    { label: 'Name given', done: name.trim() !== '', missing: 'Name the project.' },
    ...(inAdo
      ? [
          {
            label: 'Available in Azure DevOps',
            done: passed(adoVerdict),
            missing: collections.error
              ? 'Azure DevOps can’t be reached right now.'
              : adoVerdict.state === 'done'
                ? 'Fix what Azure DevOps says under its details.'
                : 'Checking Azure DevOps…',
          },
        ]
      : []),
    ...(inJira
      ? [
          {
            label: 'Available in Jira',
            done: passed(jiraVerdict),
            missing: jira.error ? 'Jira can’t be reached right now.' : !key ? 'Give the Jira project a key.' : jiraVerdict.state === 'done' ? 'Fix what Jira says under its details.' : 'Checking Jira…',
          },
        ]
      : []),
    { label: 'Team chosen', done: team !== '', missing: 'Choose the team that gets access with you.' },
    { label: 'Reason given', done: justification.trim() !== '', missing: 'Say why you need it.' },
  ]

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (ready.some((r) => !r.done) || submitting) return
    setSubmitting(true)
    try {
      const filed = await requestsApi.submitProject({
        project: name,
        description: description.trim() || undefined,
        ado: inAdo ? { collection, developers } : undefined,
        jira: inJira ? { projectKey: key, lead: leadName || undefined } : undefined,
        justification,
        teamGroup: team,
      })
      toast.success(filed.length > 1 ? `${filed.length} requests sent to DevOps for approval` : 'Sent to DevOps for approval')
      navigate(`/requests/${filed[0]!.id}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the request. Try again.')
      setSubmitting(false)
    }
  }

  const type = REQUEST_TYPES.find((t) => t.kind === (start === 'jira' ? 'create_jira_project' : 'create_project'))!
  const browseUrl = jira.data && key ? `${jira.data.baseUrl}/browse/${encodeURIComponent(key)}` : null
  const leadLabel = leadName || session?.uid || 'you'
  const accessSteps = [
    ...(inAdo ? [`In Azure DevOps, you, ${team || 'your team'}${developers.length ? ` and ${developers.length === 1 ? developers[0] : `${developers.length} developers`}` : ''} get Contributor.`] : []),
    ...(inJira ? [`In Jira, ${leadName ? `${leadName} leads it, and ` : 'you lead it, and '}you and ${team || 'your team'} join as members.`] : []),
  ]

  return (
    <RequestFormPage
      type={type}
      title={title}
      providers={where.length ? where : [start]}
      lead="One project for your team — in Azure DevOps, in Jira, or both — created once someone in DevOps approves it."
      onSubmit={submit}
      aside={
        <ReviewPanel
          ready={ready}
          steps={[
            inAdo && inJira ? 'Someone in DevOps reviews each part — they are decided one by one.' : 'Someone in DevOps reviews it.',
            `The project is created in ${where.length ? where.map((w) => (w === 'jira' ? 'Jira' : 'Azure DevOps')).join(' and ') : '…'}.`,
            ...accessSteps,
            inAdo && inJira ? 'The links appear on your requests.' : 'The link appears on your request.',
          ]}
        >
          {inAdo && (
            <SummaryItem label="In Azure DevOps">
              <span className="flex items-start gap-2">
                <AzureDevOpsIcon className="mt-0.5 size-4 shrink-0" />
                <TargetPath parts={[collection || '…', name || '…']} className="block text-[15px]" />
              </span>
            </SummaryItem>
          )}
          {inJira && (
            <SummaryItem label="In Jira">
              <span className="flex items-start gap-2">
                <JiraIcon className="mt-0.5 size-4 shrink-0" />
                <TargetPath parts={[key || '…', name || '…']} className="block text-[15px]" />
              </span>
              {key && <span className="mt-1 block text-xs text-muted-foreground">Issues numbered {key}-1, {key}-2, …</span>}
            </SummaryItem>
          )}
          {!inAdo && !inJira && <p className="text-sm text-muted-foreground">Nothing yet — choose where it goes.</p>}
          {inJira && browseUrl && (
            <SummaryItem label="Jira link once created">
              <code className="block text-xs">
                <WrappingUrl url={browseUrl} />
              </code>
            </SummaryItem>
          )}
          {inJira && (
            <SummaryItem label="Jira lead">
              <code className="text-[13px]">{leadLabel}</code>
            </SummaryItem>
          )}
        </ReviewPanel>
      }
    >
      <FormSection step={1} title="Project" description="Its name and what it is for — the same in each place it goes.">
        <Field label="Project name" htmlFor="name" hint="Usually the system name, like NBFS_LoanManagementSystem. Checked in each place you choose below.">
          <Input id="name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
        </Field>
        <Field label="Description" htmlFor="description" hint="Shown on the project in each place." optional>
          <Textarea id="description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
        </Field>
      </FormSection>

      <FormSection step={2} title="Where" description="Azure DevOps for code and pipelines, Jira for the backlog — or both. Each has its own details.">
        <SystemCard
          id="in-ado"
          icon={<AzureDevOpsIcon className="size-5" />}
          title="Azure DevOps project"
          description="Git repositories, boards and pipelines."
          checked={inAdo}
          onCheckedChange={setInAdo}
        >
          {collections.error ? (
            <Unreachable what="Azure DevOps" error={collections.error} onRetry={collections.reload} />
          ) : (
            <>
              <Field label="Collection" htmlFor="collection">
                {collections.loading || !collections.data ? (
                  <Skeleton className="h-9 w-full" />
                ) : collections.data.collections.length === 1 ? (
                  // One option is not a choice.
                  <p id="collection" className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm">
                    {collection}
                  </p>
                ) : (
                  <Select value={collection} onValueChange={(value) => value && setCollection(value)}>
                    <SelectTrigger id="collection" className="w-full">
                      <SelectValue placeholder="Choose a collection" />
                    </SelectTrigger>
                    <SelectContent>
                      {collections.data.collections.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field
                label="Developers"
                htmlFor="developers"
                optional
                hint="Login names, not display names — like jsmith — separated by commas or one per line. They get Contributor with you and your team."
              >
                <Textarea
                  id="developers"
                  value={developersText}
                  onChange={(event) => setDevelopersText(event.target.value)}
                  rows={2}
                  spellCheck={false}
                  className="font-mono"
                  placeholder="jsmith, adoe"
                  aria-describedby="ado-check"
                />
              </Field>
              <CheckMessage id="ado-check" check={checkState(adoVerdict, 'Checking Azure DevOps…', `Available — no project by that name in ${collection}${developers.length ? `, and the directory knows ${developers.length === 1 ? developers[0] : `all ${developers.length} developers`}` : ''}.`)} />
            </>
          )}
        </SystemCard>

        <SystemCard
          id="in-jira"
          icon={<JiraIcon className="size-5" />}
          title="Jira project"
          description="A software project with a backlog and boards."
          checked={inJira}
          onCheckedChange={setInJira}
        >
          {jira.error ? (
            <Unreachable what="Jira" error={jira.error} onRetry={jira.reload} />
          ) : (
            <>
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
                  aria-describedby="jira-check"
                />
              </Field>
              <Field label="Project lead" htmlFor="lead" optional hint="A Jira username, like jsmith — not a display name. Leave it empty to lead it yourself.">
                <Input
                  id="lead"
                  value={lead}
                  onChange={(event) => setLead(event.target.value.replace(/\s/g, ''))}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={session?.uid ?? ''}
                  className="w-56 font-mono"
                  aria-describedby="jira-check"
                />
              </Field>
              <CheckMessage id="jira-check" check={checkState(jiraVerdict, 'Checking Jira…', `Available — no Jira project has that name or key${leadName ? `, and Jira knows ${leadName}` : ''}.`)} />
            </>
          )}
        </SystemCard>
      </FormSection>

      <FormSection step={3} title="Access" description="Who can work in it once it exists.">
        <TeamField value={team} onChange={setChosenTeam} hint="Gets access with you, in each place it goes. One of your groups in the directory." />
      </FormSection>

      <FormSection step={4} title="Justification" description="What DevOps reads before approving.">
        <ReasonField
          value={justification}
          onChange={setJustification}
          placeholder="e.g. Loan scoring moves off the old platform this quarter; the Payments team owns it."
          hint="Say who it is for and what it will hold."
        />
      </FormSection>

      <FormActions ready={ready} submitting={submitting} label={inAdo && inJira ? 'Send both for approval' : 'Send for approval'} />
    </RequestFormPage>
  )
}

/** One place the project can go: ticked, its own details open beneath. */
function SystemCard({
  id,
  icon,
  title,
  description,
  checked,
  onCheckedChange,
  children,
}: {
  id: string
  icon: ReactNode
  title: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    // Ticked is the focus blue, not the brand red: red only ever means "act on this".
    <div className={`rounded-lg border transition-colors ${checked ? 'border-ring/60 bg-muted/20' : 'hover:bg-muted/20'}`}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3 p-4">
        <Checkbox id={id} checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} className="mt-0.5" />
        <span aria-hidden className="mt-px">
          {icon}
        </span>
        <span className="grid gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </span>
      </label>
      {checked && <div className="space-y-5 border-t px-4 pt-4 pb-5">{children}</div>}
    </div>
  )
}

/** A system that cannot be reached: said in its own card, so the other can still be asked for. */
function Unreachable({ what, error, onRetry }: { what: string; error: ReactNode; onRetry: () => void }) {
  return (
    <div className="text-sm">
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4 text-warning" aria-hidden /> {what} can’t be reached right now, so nothing can be checked there.
      </p>
      <p className="mt-1 text-muted-foreground">{error}</p>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
