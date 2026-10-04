import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Clock, Plus, TriangleAlert, UserSearch } from 'lucide-react'
import { Kpi } from '@/components/kpi.tsx'
import { PAGE, PageHeader } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { rbacApi, type Binding, type Catalogue } from './api.ts'
import { AuditTab } from './audit-tab.tsx'
import { BindingsTab } from './bindings-tab.tsx'
import { CheckTab } from './check-tab.tsx'
import { GrantSheet, type GrantStart } from './grant-sheet.tsx'
import { RolesTab } from './roles-tab.tsx'
import { EXPIRING_DAYS, statusOf } from './shared.tsx'

const TABS = ['bindings', 'check', 'roles', 'audit'] as const
type Tab = (typeof TABS)[number]

/**
 * Who may do what, and the record of every change to it. Roles and what they
 * allow are fixed in code; this page manages who holds them.
 *
 * Across the top, how access stands — bindings to groups and to people, what
 * is about to lapse, what needs cleaning up — and a callout when something
 * does. Then four tabs, each in the URL with its filters: the bindings as a
 * table to work in, a person checked, the roles against their permissions,
 * and the audit log. Granting opens a panel beside the page. Mounted behind
 * `rbac.manage`, which the API checks again.
 */
export function AccessPage() {
  usePageTitle('Access')
  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'bindings'
  const go = (next: Tab, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams()
    if (next !== 'bindings') p.set('tab', next)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    setParams(p)
  }

  const catalogue = useResource(() => rbacApi.catalogue(), [])
  const bindings = useResource(() => rbacApi.bindings(), [])
  const audit = useResource(() => rbacApi.audit(), [])
  const suggestions = useResource(() => rbacApi.suggestions(), [])
  const reload = () => {
    bindings.reload()
    audit.reload()
    suggestions.reload()
  }
  const [granting, setGranting] = useState<GrantStart | null>(null)

  const c = catalogue.data
  const b = bindings.data

  return (
    <div className={`${PAGE} space-y-6`}>
      <PageHeader
        title="Access"
        description="Who holds which role, where, and until when. Grant to a directory group where you can; to one person only as an exception."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => go('check')}>
              <UserSearch /> Check someone
            </Button>
            <Button size="sm" onClick={() => setGranting({})} disabled={!c}>
              <Plus /> Grant a role
            </Button>
          </>
        }
      />

      {c && b ? (
        <Overview bindings={b} catalogue={c} onShow={(status) => go('bindings', { status })} />
      ) : (
        <Loading label="Loading access…">
          <RowsSkeleton rows={2} />
        </Loading>
      )}

      <Tabs value={tab} onValueChange={(v) => go(v as Tab)}>
        {/* Its own scroll on a phone, where four tabs are wider than the screen. */}
        <div className="-mx-1 max-w-full overflow-x-auto px-1">
        <TabsList className="w-max">
          <TabsTrigger value="bindings">
            Bindings{b && <span className="text-muted-foreground tabular-nums">{b.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="check">Check someone</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        </div>

        <TabsContent value="bindings" className="mt-4 grid grid-cols-[minmax(0,1fr)]">
          {bindings.error && !b ? (
            <p className="text-sm text-destructive">{bindings.error}</p>
          ) : !b || !c ? (
            <Loading label="Loading bindings…">
              <RowsSkeleton rows={5} />
            </Loading>
          ) : (
            <BindingsTab
              bindings={b}
              catalogue={c}
              onChanged={reload}
              onCheck={(uid) => go('check', { uid })}
              onGrantLike={(like) => setGranting({ role: like.role, scopeType: like.scopeType, scope: like.scope })}
            />
          )}
        </TabsContent>

        <TabsContent value="check" className="mt-4 grid grid-cols-[minmax(0,1fr)]">
          {c && <CheckTab uid={params.get('uid') ?? ''} onUid={(uid) => go('check', { uid })} catalogue={c} />}
        </TabsContent>

        <TabsContent value="roles" className="mt-4 grid grid-cols-[minmax(0,1fr)]">
          {c && b && <RolesTab catalogue={c} bindings={b} onRole={(role) => go('bindings', { role })} />}
        </TabsContent>

        <TabsContent value="audit" className="mt-4 grid grid-cols-[minmax(0,1fr)]">
          {!audit.data || !c ? (
            <Loading label="Loading the audit log…">
              <RowsSkeleton rows={5} />
            </Loading>
          ) : (
            <AuditTab entries={audit.data} catalogue={c} />
          )}
        </TabsContent>
      </Tabs>

      {c && <GrantSheet start={granting} onClose={() => setGranting(null)} catalogue={c} suggestions={suggestions.data} onGranted={reload} />}
    </div>
  )
}

/** The numbers that say how access stands, and a callout for what needs someone. */
function Overview({ bindings, catalogue, onShow }: { bindings: Binding[]; catalogue: Catalogue; onShow: (status: string) => void }) {
  const rows = bindings.filter((x) => !x.builtIn)
  const groups = rows.filter((x) => x.subjectType === 'group')
  const people = rows.filter((x) => x.subjectType === 'user')
  const status = (s: string) => rows.filter((x) => statusOf(x, catalogue) === s)
  const expiring = status('expiring')
  const expired = status('expired')
  const orphaned = status('orphaned')
  const cleanup = expired.length + orphaned.length
  const open = people.filter((x) => !x.expiresAt && statusOf(x, catalogue) === 'active').length

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Bindings" value={rows.length.toLocaleString()} detail={`${new Set(groups.map((x) => x.subject.toLowerCase())).size} groups · ${new Set(people.map((x) => x.subject.toLowerCase())).size} people · 2 built in`} delta={null} />
        <Kpi label="Granted to people by name" value={people.length.toLocaleString()} detail={open ? `${open} with no expiry` : 'Every one ends'} delta={null} />
        <Kpi label={`Expiring in ${EXPIRING_DAYS} days`} value={expiring.length.toLocaleString()} detail={expiring.length ? 'Extend or let them lapse' : 'Nothing about to lapse'} delta={null} />
        <Kpi label="Need cleaning up" value={cleanup.toLocaleString()} detail={cleanup ? `${expired.length} expired · ${orphaned.length} role gone` : 'Nothing stale'} alarm={cleanup > 0} delta={null} />
      </div>

      {(expiring.length > 0 || cleanup > 0) && (
        <Alert className="reveal">
          {cleanup > 0 ? <TriangleAlert className="text-destructive" /> : <Clock className="text-warning" />}
          <AlertTitle>{cleanup > 0 ? 'Some bindings grant nothing any more' : 'Some bindings are about to lapse'}</AlertTitle>
          <AlertDescription>
            <p>
              {[
                expiring.length && `${expiring.length} ${expiring.length === 1 ? 'ends' : 'end'} within ${EXPIRING_DAYS} days`,
                expired.length && `${expired.length} expired and still listed`,
                orphaned.length && `${orphaned.length} ${orphaned.length === 1 ? 'names a role' : 'name roles'} the code no longer has`,
              ]
                .filter(Boolean)
                .join(', ')}
              .
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {expiring.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => onShow('expiring')}>
                  Show what is expiring
                </Button>
              )}
              {expired.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => onShow('expired')}>
                  Show expired
                </Button>
              )}
              {orphaned.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => onShow('orphaned')}>
                  Show roles gone
                </Button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}
