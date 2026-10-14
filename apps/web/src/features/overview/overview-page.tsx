import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, LayoutGrid, RotateCcw } from 'lucide-react'
import { Navigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ErrorBoundary } from '@/components/error-boundary.tsx'
import { PAGE } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { queryClient } from '@/lib/query-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { preferencesApi } from './api.ts'
import { CARDS, cardsFor, type CardId, type Viewer } from './card-list.ts'
import { ApprovalsCard, CatalogCard, JenkinsCard, NeedsYouCard, PipelinesCard, ProjectsCard, RequestsCard, useNeeds } from './cards.tsx'
import { arrange, greeting, move } from './layout.ts'

/**
 * The home page, made for whoever signs in: what needs them first, then the
 * parts of the portal that are theirs — their requests and pipelines, their
 * teams' projects, and, for those who decide or run Jenkins, what waits on
 * them there. Which cards there are follows what someone may do; their order
 * and which are hidden is theirs to choose (Customize), kept with their
 * account so it follows them (apps/api modules/preferences).
 *
 * Every card draws inside its own error boundary: one that cannot draw says
 * so, and the rest of the page stays.
 */
export function OverviewPage() {
  usePageTitle('Overview')
  const [params] = useSearchParams()
  // The map lived at / and linked there with ?q=; keep those links working.
  if (params.get('q')) return <Navigate to={`/map?${params}`} replace />
  return <Overview />
}

function Overview() {
  const { can, canSomewhere, profile } = useProfile()
  const viewer: Viewer = {
    profile,
    decider: canSomewhere('requests.decide_access'),
    jenkins: can('jenkins.view'),
    pipelines: can('pipelines.view'),
    catalog: can('catalog.view'),
    syncs: can('catalog.sync'),
  }
  const { available, hiddenByDefault } = cardsFor(viewer)
  const saved = useResource(['preferences', 'overview'], () => preferencesApi.overview())
  const { shown, hidden } = arrange(available, hiddenByDefault, saved.data?.layout ?? null)
  const { needs, loading } = useNeeds(viewer)

  // Customizing works on a draft; Done saves it, Cancel drops it.
  const [draft, setDraft] = useState<{ shown: string[]; hidden: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const editing = draft !== null

  const save = async (next: { shown: string[]; hidden: string[] } | 'reset') => {
    setSaving(true)
    try {
      if (next === 'reset') await preferencesApi.resetOverview()
      else await preferencesApi.saveOverview({ order: [...next.shown, ...next.hidden], hidden: next.hidden })
      await queryClient.invalidateQueries({ queryKey: ['preferences', 'overview'] })
      setDraft(null)
      toast.success(next === 'reset' ? 'Back to the portal’s own Overview for you.' : 'Saved. Your Overview looks like this wherever you sign in.')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save your Overview. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const first = profile?.name?.split(' ')[0]
  const summary = loading ? 'Looking at what is yours…' : needs.length === 0 ? 'Nothing needs you right now.' : `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you.`

  return (
    <div className={PAGE}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">
            {greeting(new Date().getHours())}
            {first ? `, ${first}` : ''}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {summary}
            {profile?.title || profile?.division ? <span className="hidden sm:inline"> · {[profile.title, profile.division].filter(Boolean).join(', ')}</span> : null}
          </p>
        </div>
        {editing ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => void save('reset')} disabled={saving}>
              <RotateCcw /> Reset to default
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save(draft)} disabled={saving}>
              {saving ? <Spinner /> : <Check />} Done
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setDraft({ shown, hidden })} disabled={!saved.data && !saved.error}>
            <LayoutGrid /> Customize
          </Button>
        )}
      </header>

      {editing ? (
        <Customize draft={draft} onChange={setDraft} />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {shown.map((id) => (
            <div key={id} className={CARDS[id as CardId].wide ? 'lg:col-span-2' : ''}>
              <ErrorBoundary variant="card" title={CARDS[id as CardId].title}>
                {card(id as CardId, viewer)}
              </ErrorBoundary>
            </div>
          ))}
          {shown.length === 0 && (
            <p className="rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground lg:col-span-2">
              Every card is hidden. Customize to show some again.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function card(id: CardId, viewer: Viewer): ReactNode {
  switch (id) {
    case 'needs-you':
      return <NeedsYouCard viewer={viewer} />
    case 'approvals':
      return <ApprovalsCard />
    case 'jenkins':
      return <JenkinsCard />
    case 'pipelines':
      return <PipelinesCard />
    case 'requests':
      return <RequestsCard />
    case 'projects':
      return <ProjectsCard profile={viewer.profile} />
    case 'catalog':
      return <CatalogCard />
  }
}

/** Arranging the cards: each with its move and hide buttons, and the hidden ones to bring back. */
function Customize({ draft, onChange }: { draft: { shown: string[]; hidden: string[] }; onChange: (next: { shown: string[]; hidden: string[] }) => void }) {
  const info = (id: string) => CARDS[id as CardId]
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section aria-labelledby="shown-cards" className="rounded-xl border bg-card">
        <h2 id="shown-cards" className="border-b px-4 py-3 text-sm font-semibold">
          On your Overview, in this order
        </h2>
        {draft.shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Nothing — show a card from the right.</p>
        ) : (
          <ol className="divide-y">
            {draft.shown.map((id, i) => (
              <li key={id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-5 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{info(id).title}</span>
                  <span className="block text-xs text-muted-foreground">{info(id).description}</span>
                </span>
                <Button size="icon" variant="ghost" className="size-8" onClick={() => onChange({ ...draft, shown: move(draft.shown, id, -1) })} disabled={i === 0} aria-label={`Move ${info(id).title} up`}>
                  <ArrowUp />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => onChange({ ...draft, shown: move(draft.shown, id, 1) })}
                  disabled={i === draft.shown.length - 1}
                  aria-label={`Move ${info(id).title} down`}
                >
                  <ArrowDown />
                </Button>
                <Button size="sm" variant="outline" onClick={() => onChange({ shown: draft.shown.filter((x) => x !== id), hidden: [...draft.hidden, id] })} aria-label={`Hide ${info(id).title}`}>
                  <EyeOff /> <span className="hidden sm:inline">Hide</span>
                </Button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="hidden-cards" className="rounded-xl border bg-card">
        <h2 id="hidden-cards" className="border-b px-4 py-3 text-sm font-semibold">
          Hidden
        </h2>
        {draft.hidden.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Every card you can have is on your Overview.</p>
        ) : (
          <ul className="divide-y">
            {draft.hidden.map((id) => (
              <li key={id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{info(id).title}</span>
                  <span className="block text-xs text-muted-foreground">{info(id).description}</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => onChange({ shown: [...draft.shown, id], hidden: draft.hidden.filter((x) => x !== id) })} aria-label={`Show ${info(id).title}`}>
                  <Eye /> Show
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">Kept with your account: your Overview looks the same wherever you sign in. Which cards there are follows what you may do in the portal.</p>
      </section>
    </div>
  )
}
