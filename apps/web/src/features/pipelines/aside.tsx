import { Section } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import type { Pending } from '@/features/jenkins/actions.tsx'
import { JobName } from '@/features/jenkins/result.tsx'
import { since } from '@/features/requests/status.tsx'
import type { MyRuns } from './api.ts'

/** The side column: what is queued for you, and who decides who sees what. */

export function Aside({ data, onAct }: { data: MyRuns; onAct: (pending: Pending) => void }) {
  const operable = data.runs.filter((r) => r.canOperate).length
  return (
    <>
      <Section title="What you can do here">
        <div className="space-y-2 text-sm text-muted-foreground">
          {operable === 0 ? (
            <>
              <p>You can follow these runs and open their logs.</p>
              <p>
                Running one again or stopping it needs the <span className="text-foreground">Pipeline operator</span> role for the team or project it is for — writing the commit is not enough. DevOps grant it on the Access page.
              </p>
            </>
          ) : operable === data.runs.length ? (
            <p>You can run again, stop and dequeue every run here. Each action runs as the portal’s service account, and the portal records that you asked.</p>
          ) : (
            <p>You can run again, stop and dequeue the runs of the projects your role covers ({operable} of {data.runs.length}). The rest you can follow and read.</p>
          )}
        </div>
      </Section>

      <WhoSees access={data.access} />

      <Section title="Waiting in the queue" description={data.queueError ? `Jenkins’ queue could not be read: ${data.queueError}` : undefined}>
        {data.queue.length === 0 ? (
          !data.queueError && <p className="text-sm text-muted-foreground">Nothing of yours is waiting.</p>
        ) : (
          <ul className="space-y-3">
            {data.queue.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <JobName name={item.job ?? item.name} className="text-sm" />
                  {item.matchedBy === 'parameters' && <span className="ml-1.5 font-mono text-xs text-muted-foreground">→ {item.applications.join(', ')}</span>}
                  <p className="text-xs text-muted-foreground">
                    Since {since(item.since)}
                    {item.why && <> · {item.why}</>}
                  </p>
                </div>
                {item.canOperate && (
                  <Button size="sm" variant="ghost" onClick={() => onAct({ kind: 'cancel', item })} aria-label={`Take ${item.job ?? item.name} out of the queue`}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

/** The groups behind your runs, most runs first. */

const STRATEGY = { 'role-strategy': 'its role-based strategy', matrix: 'the permissions on its folders and jobs' } as const

/** Where whose-run-is-whose comes from, so a missing run has an explanation. */
function WhoSees({ access }: { access: MyRuns['access'] }) {
  return (
    <Section title="Whose runs these are">
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          <span className="text-foreground">Yours:</span> runs you started, and runs that built a commit you wrote — whoever started them.
        </p>
        <p>
          <span className="text-foreground">Your teams’:</span> runs for a project a team of yours owns in the inventories. On a shared build or deploy job, the run’s parameters say which project it is for.
        </p>
        {access.decides === 'jenkins' && (access.source === 'role-strategy' || access.source === 'matrix') ? (
          <p>
            Jenkins has the last word: a team’s run shows only if {STRATEGY[access.source]} lets the team read its job
            {access.readAt && <> (read {since(access.readAt)})</>}.
          </p>
        ) : (
          <p>Jenkins has no per-team rules the portal could read, so the inventories decide on their own.</p>
        )}
        {!access.ok && access.error && (
          <p className="text-warning">
            The last read of Jenkins’ rules failed: {access.error}
            {access.readAt && ' The rules read before still apply.'}
          </p>
        )}
        {access.warnings.map((w) => (
          <p key={w} className="text-warning">
            {w}
          </p>
        ))}
      </div>
    </Section>
  )
}

/** "Payments’", "DEVJAVA’s". */
