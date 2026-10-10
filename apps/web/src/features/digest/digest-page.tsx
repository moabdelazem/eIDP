import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock, RotateCcw, Sparkles, TriangleAlert, Users } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/empty-state.tsx'
import { Kpi, signed } from '@/components/kpi.tsx'
import { PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { CardSkeleton, HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { duration, percent } from '@/features/jenkins/api.ts'
import { JobName, ResultBadge } from '@/features/jenkins/result.tsx'
import { KIND_ICON, KIND_LABEL, since, TargetPath } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { digestApi, type Digest, type DigestIndex, type RequestItem } from './api.ts'

/**
 * A team's week (services/digest.ts): how its builds went against the week
 * before, the pipelines that broke and the requests for its projects —
 * counted by the portal — with the model's few lines on
 * top, labelled as its reading. The week in progress is counted live and has
 * no summary until it ends.
 *
 * Team and week live in the URL (`?team=Payments&week=2026-09-28`), so a
 * link lands on one digest. Without a week it opens on the last finished one.
 */
export function DigestPage() {
  const index = useResource(() => digestApi.index(), [])
  const [params, setParams] = useSearchParams()

  if (index.error && !index.data) return <div className={PAGE}><p className="text-sm text-destructive">{index.error}</p></div>
  if (!index.data) {
    return (
      <div className={PAGE}>
        <Loading label="Loading your teams…">
          <HeaderSkeleton />
        </Loading>
      </div>
    )
  }
  const ix = index.data
  if (ix.teams.length === 0) return <NoTeam />

  const asked = params.get('team')
  const team = ix.teams.find((t) => t.toLowerCase() === asked?.toLowerCase()) ?? ix.mine[0] ?? ix.teams[0]!
  const week = params.get('week') ?? ix.weeks[1] ?? ix.current
  const go = (next: { team?: string; week?: string }) => {
    const p = new URLSearchParams(params)
    if (next.team) p.set('team', next.team)
    if (next.week) p.set('week', next.week)
    setParams(p)
  }

  return <TeamWeek key={`${team}|${week}`} index={ix} team={team} week={week} go={go} />
}

function NoTeam() {
  usePageTitle('Weekly digest')
  return (
    <div className={PAGE}>
      <EmptyState title="No team digest for you yet" icon={Users}>
        A digest is written each week for every team that owns a system in the inventories (<code>team.yml</code>). None of
        your directory groups is one of them — your profile lists the groups the directory returned.
      </EmptyState>
    </div>
  )
}

function TeamWeek({ index, team, week, go }: { index: DigestIndex; team: string; week: string; go: (next: { team?: string; week?: string }) => void }) {
  const digest = useResource(() => digestApi.digest(team, week), [team, week])
  const [busy, setBusy] = useState(false)
  usePageTitle(`${team} · week of ${short(week)} — Weekly digest`)

  const weeks = digest.data?.weeks ?? index.weeks
  const at = weeks.indexOf(week)
  const newer = at > 0 ? weeks[at - 1] : undefined
  const older = at >= 0 ? weeks[at + 1] : undefined

  async function regenerate() {
    setBusy(true)
    try {
      await digestApi.regenerate(team, week)
      digest.reload()
      toast.success(`Wrote ${team}’s week of ${short(week)} again.`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not write it again. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const d = digest.data
  return (
    <div className={`${PAGE} space-y-6`}>
      <PageHeader
        title="Weekly digest"
        description={
          <>
            {team}, {range(week)}
            {week === index.current && ' — so far'}.
          </>
        }
        actions={
          <>
            {index.teams.length > 1 && (
              <Select value={team} onValueChange={(t) => go({ team: t })}>
                <SelectTrigger aria-label="Team" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ['Your teams', index.teams.filter((t) => index.mine.includes(t))],
                    ['Other teams', index.teams.filter((t) => !index.mine.includes(t))],
                  ].map(
                    ([label, teams]) =>
                      teams.length > 0 && (
                        <SelectGroup key={label as string}>
                          <SelectLabel>{label}</SelectLabel>
                          {(teams as string[]).map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ),
                  )}
                </SelectContent>
              </Select>
            )}
            <div className="flex items-center rounded-md border" role="group" aria-label="Week">
              <Button variant="ghost" size="icon" disabled={!older} onClick={() => older && go({ week: older })} aria-label="The week before">
                <ChevronLeft />
              </Button>
              <span className="min-w-28 px-1 text-center text-sm tabular-nums">{week === index.current ? 'This week' : `Week of ${short(week)}`}</span>
              <Button variant="ghost" size="icon" disabled={!newer} onClick={() => newer && go({ week: newer })} aria-label="The week after">
                <ChevronRight />
              </Button>
            </div>
            {index.canRegenerate && d && !d.live && (
              <Button variant="outline" onClick={() => void regenerate()} disabled={busy}>
                {busy ? <Spinner /> : <RotateCcw />} Write again
              </Button>
            )}
          </>
        }
      />

      {digest.error && !d ? (
        <p className="text-sm text-destructive">{digest.error}</p>
      ) : !d ? (
        <Loading label="Counting the week…">
          <div className="space-y-6">
            <CardSkeleton />
            <RowsSkeleton rows={4} />
          </div>
        </Loading>
      ) : (
        <Body digest={d} />
      )}
    </div>
  )
}

function Body({ digest: d }: { digest: Digest }) {
  const { can } = useProfile()
  const f = d.facts
  return (
    <>
      <Summary digest={d} />
      <Kpis digest={d} />
      <Split
        className=""
        aside={
          <>
            <Busiest digest={d} />
            <Section title="Projects" description="What the inventories say this team owns — the runs and requests above are theirs.">
              {f.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">None recorded.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {f.projects.map((p) => (
                    <li key={p} className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        }
      >
        <Broke digest={d} buildPath={can('jenkins.view') ? '/jenkins/build' : '/pipelines/build'} />
        <Requests digest={d} linked={can('requests.decide')} />
      </Split>
    </>
  )
}

/** The model's words, or why there are none. Never mistaken for the facts: labelled, and set apart. */
function Summary({ digest: d }: { digest: Digest }) {
  if (d.live) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
        <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
        The week in progress, counted as of now. It is written up, with a summary, once it ends on {short(d.facts.ends)}.
      </p>
    )
  }
  return (
    <section aria-label="Summary" className="rounded-xl border bg-card px-5 py-4 shadow-sm">
      {d.summary ? (
        <>
          <p className="text-base leading-relaxed">{d.summary}</p>
          {d.highlights.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {d.highlights.map((h) => (
                <li key={h} className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[var(--chart-1)]" aria-hidden />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
            <Sparkles className="size-3 text-[var(--chart-1)]" aria-hidden />
            Written by {d.model} from the numbers below, {since(d.createdAt)}. It can be wrong; the numbers are the portal’s.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No summary for this week — {d.error ? `the model could not write one: ${d.error}` : 'no model was configured when it was written'}. The numbers below are
          the portal’s own.
        </p>
      )}
    </section>
  )
}

function Kpis({ digest: d }: { digest: Digest }) {
  const b = d.facts.builds
  const r = d.facts.requests
  const against = 'the week before'
  // Half a week of builds against a whole one is not a change; a rate is.
  const counts = !d.live && !!b && b.previous.builds > 0
  const broken = (t: { failed: number; unstable: number }) => t.failed + t.unstable
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {b ? (
        <>
          <Kpi
            label="Builds"
            value={b.current.builds.toLocaleString()}
            detail={`${b.pipelines} ${b.pipelines === 1 ? 'pipeline' : 'pipelines'}`}
            delta={counts ? { change: b.current.builds - b.previous.builds, text: signed(b.current.builds - b.previous.builds), good: null } : null}
            against={against}
          />
          <Kpi
            label="Success rate"
            value={percent(b.current.successRate)}
            detail={`${b.current.passed.toLocaleString()} passed`}
            delta={
              b.current.successRate !== null && b.previous.successRate !== null
                ? (() => {
                    const points = Math.round((b.current.successRate - b.previous.successRate) * 100)
                    return { change: points, text: `${signed(points)} pts`, good: 'up' as const }
                  })()
                : null
            }
            against={against}
          />
          <Kpi
            label="Failed or unstable"
            value={broken(b.current).toLocaleString()}
            detail={`${b.failing.filter((p) => p.broken).length} still broken`}
            alarm={b.failing.some((p) => p.broken)}
            delta={counts ? { change: broken(b.current) - broken(b.previous), text: signed(broken(b.current) - broken(b.previous)), good: 'down' } : null}
            against={against}
          />
          <Kpi
            label="Time to fix"
            value={b.fixes.medianMs === null ? '—' : duration(b.fixes.medianMs)}
            detail={b.fixes.count === 0 ? 'Nothing broken was fixed' : `${b.fixes.count} ${b.fixes.count === 1 ? 'fix' : 'fixes'} · longest ${duration(b.fixes.longestMs ?? 0)}`}
            delta={null}
          />
        </>
      ) : (
        <div className="col-span-2 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground md:col-span-3 xl:col-span-4">
          Builds were not counted: {d.facts.buildsError}
        </div>
      )}
      <Kpi label="Requests filed" value={r.filed.toLocaleString()} detail={`${r.completed} done · ${r.waiting.length} waiting`} delta={null} />
    </div>
  )
}

function Broke({ digest: d, buildPath }: { digest: Digest; buildPath: string }) {
  const b = d.facts.builds
  if (!b) return null
  return (
    <Section
      flush
      title="Pipelines that broke"
      description="Each failed or went unstable at least once this week. Still broken means its last finished build of the week did."
    >
      {b.failing.length === 0 ? (
        <p className="flex items-center gap-2 px-6 py-5 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-success" aria-hidden />
          {b.current.builds === 0 ? 'Nothing was built.' : 'Every build passed.'}
        </p>
      ) : (
        <ul className="divide-y">
          {b.failing.map((p) => (
            <li key={`${p.job}|${p.applications.join(',')}`} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 px-6 py-3">
              <div className="min-w-0">
                <Link to={`${buildPath}?job=${encodeURIComponent(p.job)}&number=${p.last.number}`} className="hover:underline">
                  <JobName name={p.job} className="text-sm" />
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {p.applications.length > 0 && <>for {p.applications.join(', ')} · </>}
                  {p.failures} of {p.builds} {p.builds === 1 ? 'build' : 'builds'} broke · last #{p.last.number} {since(p.last.at)}
                </p>
              </div>
              {p.broken ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                  <CircleAlert className="size-3.5" aria-hidden /> Still broken
                </span>
              ) : (
                <ResultBadge result="success" />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Requests({ digest: d, linked }: { digest: Digest; linked: boolean }) {
  const r = d.facts.requests
  const kinds = Object.entries(r.byKind) as [keyof typeof KIND_LABEL, number][]
  return (
    <Section
      title="Requests"
      description={
        r.filed === 0
          ? 'Nothing was filed for this team or its projects this week.'
          : `${r.filed} filed — ${kinds.map(([k, n]) => `${n} ${KIND_LABEL[k].toLowerCase()}`).join(', ')}. ${r.completed} done, ${r.rejected} rejected.`
      }
    >
      {r.failed.length === 0 && r.waiting.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing failed, and nothing is waiting for approval.</p>
      ) : (
        <div className="space-y-5">
          {r.failed.length > 0 && <RequestList title="Failed" icon={TriangleAlert} tone="text-destructive" items={r.failed} linked={linked} />}
          {r.waiting.length > 0 && <RequestList title="Waiting for approval" icon={Clock} tone="text-warning" items={r.waiting} linked={linked} />}
        </div>
      )}
    </Section>
  )
}

function RequestList({ title, icon: Icon, tone, items, linked }: { title: string; icon: typeof Clock; tone: string; items: RequestItem[]; linked: boolean }) {
  return (
    <div>
      <h2 className={`mb-2 flex items-center gap-1.5 text-xs font-medium ${tone}`}>
        <Icon className="size-3.5" aria-hidden /> {title}
      </h2>
      <ul className="space-y-2.5">
        {items.map((x) => {
          const KindIcon = KIND_ICON[x.kind]
          const name = <TargetPath parts={x.target.split('/')} className="text-sm" />
          return (
            <li key={x.id} className="flex items-start gap-2.5">
              <KindIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={KIND_LABEL[x.kind]} />
              <div className="min-w-0">
                {linked ? (
                  <Link to={`/requests/${x.id}`} className="hover:underline">
                    {name}
                  </Link>
                ) : (
                  name
                )}
                <p className="text-xs text-muted-foreground">
                  {x.by}, {since(x.at)}
                  {x.error && <> — {x.error}</>}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Busiest({ digest: d }: { digest: Digest }) {
  const b = d.facts.builds
  if (!b || b.busiest.length === 0) return null
  const most = b.busiest[0]!.builds
  return (
    <Section title="Most built" description="Applications by builds this week.">
      <ul className="space-y-2.5 text-sm">
        {b.busiest.map((a) => (
          <li key={a.application}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-xs">{a.application}</span>
              <span className="tabular-nums text-muted-foreground">{a.builds}</span>
            </div>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${(a.builds / most) * 100}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ---- dates ------------------------------------------------------------------

const day = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts })

/** "Sep 28" */
function short(week: string): string {
  return day(week, { month: 'short', day: 'numeric' })
}

/** "Mon Sep 28 – Sun Oct 4" */
function range(week: string): string {
  const sunday = new Date(new Date(`${week}T00:00:00Z`).getTime() + 6 * 86_400_000).toISOString()
  return `${day(week, { weekday: 'short', month: 'short', day: 'numeric' })} – ${day(sunday, { weekday: 'short', month: 'short', day: 'numeric' })}`
}

