import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RotateCcw, Square } from 'lucide-react'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { Facts } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useResource } from '@/lib/use-resource.ts'
import { since } from '@/features/requests/status.tsx'
import { duration, jenkinsApi, type Build } from './api.ts'
import { JobName, ResultBadge } from './result.tsx'
import type { Pending } from './actions.tsx'

/**
 * A build at a glance, without leaving the page: what started it, what it was
 * given, and the end of its log — where a failure says why. Re-run and stop
 * are offered here to those who may, and open their own confirmation.
 */
export function RunDialog({
  build,
  onClose,
  canOperate,
  onAct,
}: {
  build: Pick<Build, 'job' | 'number'> | null
  onClose: () => void
  canOperate: boolean
  onAct: (pending: Pending) => void
}) {
  return (
    <Dialog open={build !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {build && <RunBody key={`${build.job}#${build.number}`} build={build} canOperate={canOperate} onAct={onAct} />}
      </DialogContent>
    </Dialog>
  )
}

function RunBody({ build, canOperate, onAct }: { build: Pick<Build, 'job' | 'number'>; canOperate: boolean; onAct: (pending: Pending) => void }) {
  // A running build's log grows; follow it until it ends, then stop asking.
  const [following, setFollowing] = useState(true)
  const run = useResource(() => jenkinsApi.run(build.job, build.number), [build.job, build.number], {
    pollMs: following ? 5_000 : null,
  })
  const r = run.data
  const running = r?.result === 'running'
  if (r && !running && following) setFollowing(false)
  const log = useRef<HTMLPreElement>(null)

  // Open at the end of the log, where the failure is.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [r?.log])

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-start justify-between gap-3 pr-6">
          <DialogTitle className="min-w-0 text-base">
            <JobName name={build.job} /> <span className="font-mono text-muted-foreground">#{build.number}</span>
          </DialogTitle>
          {r && <ResultBadge result={r.result} />}
        </div>
        <DialogDescription>
          {r ? `Started ${since(r.startedAt)}${running ? '' : `, took ${duration(r.durationMs)}`}.` : 'Loading the build…'}
        </DialogDescription>
      </DialogHeader>

      {run.error && !r ? (
        <p className="text-sm text-destructive">{run.error}</p>
      ) : !r ? (
        <Loading label="Loading the build…">
          <RowsSkeleton rows={4} bordered={false} />
        </Loading>
      ) : (
        <>
          <Facts
            empty="—"
            items={[
              ['Started by', r.causes.join('; ') || null],
              ['Started', new Date(r.startedAt).toLocaleString()],
              ...(r.parameters.length
                ? [
                    [
                      'Parameters',
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs">
                        {r.parameters.map((p) => (
                          <div key={p.name} className="contents">
                            <dt className="text-muted-foreground">{p.name}</dt>
                            <dd className={`break-words ${p.hidden ? 'text-muted-foreground italic' : ''}`}>{p.value ?? '—'}</dd>
                          </div>
                        ))}
                      </dl>,
                    ] as [string, React.ReactNode],
                  ]
                : []),
            ]}
          />

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              {r.logTruncated ? 'End of the console log' : 'Console log'}
            </p>
            <pre
              ref={log}
              tabIndex={0}
              aria-label="Console log"
              className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
            >
              {r.log || 'The log is empty.'}
            </pre>
          </div>

          {canOperate && r.notReplayable && !running && (
            <p className="text-sm text-muted-foreground">{r.notReplayable}</p>
          )}
        </>
      )}

      <DialogFooter className="gap-2 sm:justify-between">
        <Button asChild variant="outline" size="sm">
          <a href={r?.url ?? '#'} target="_blank" rel="noreferrer" aria-disabled={!r}>
            <JenkinsIcon /> Open in Jenkins <ExternalLink />
          </a>
        </Button>
        {canOperate && r && (
          <div className="flex gap-2">
            {running ? (
              <Button size="sm" variant="outline" onClick={() => onAct({ kind: 'stop', build })}>
                <Square /> Stop
              </Button>
            ) : (
              <Button size="sm" disabled={r.notReplayable !== null} onClick={() => onAct({ kind: 'rebuild', build })}>
                <RotateCcw /> Run again
              </Button>
            )}
          </div>
        )}
      </DialogFooter>
    </>
  )
}
