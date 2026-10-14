import { ChevronRight, ChevronsDownUp, ChevronsUpDown, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { StageNode } from './parse.ts'

/**
 * The log's stages as a tree beside it, as Jenkins' Pipeline Graph View lists
 * them: parallel branches under their stage, each with what went wrong in it.
 * A name jumps to its heading; the chevron folds its lines away in the log.
 * The stage a running build is in is marked.
 */
export function StageTree({
  stages,
  folded,
  running,
  current,
  onGo,
  onToggle,
  onFoldAll,
  onUnfoldAll,
}: {
  stages: StageNode[]
  folded: Set<number>
  /** The heading of the stage a running build is in. */
  running: number | null
  /** The heading of the stage the line in focus is in. */
  current: number | null
  onGo: (line: number) => void
  onToggle: (line: number) => void
  onFoldAll: () => void
  onUnfoldAll: () => void
}) {
  // A stage under a folded one is out of sight in the log; in the tree it stays, quieter.
  const hiddenBy = (s: StageNode): boolean => {
    for (let p = s.parent; p !== null; p = stages.find((x) => x.line === p)?.parent ?? null) if (folded.has(p)) return true
    return false
  }
  return (
    <nav aria-label="Stages" className="flex min-h-0 w-full flex-col">
      <div className="flex items-center gap-1 border-b px-3 py-1.5">
        <span className="flex-1 text-xs font-medium text-muted-foreground">Stages</span>
        <Button size="icon" variant="ghost" className="size-6" onClick={onFoldAll} aria-label="Fold every stage" title="Fold every stage ([)">
          <ChevronsDownUp className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="size-6" onClick={onUnfoldAll} aria-label="Unfold every stage" title="Unfold every stage (])">
          <ChevronsUpDown className="size-3.5" />
        </Button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto py-1 text-xs">
        {stages.map((s) => {
          const isFolded = folded.has(s.line)
          return (
            <li
              key={s.line}
              className={`group flex items-center gap-1 pr-2 ${s.line === current ? 'bg-secondary/70' : 'hover:bg-muted/60'} ${hiddenBy(s) ? 'opacity-60' : ''}`}
              style={{ paddingLeft: `${0.5 + s.depth * 0.875}rem` }}
            >
              <button
                type="button"
                onClick={() => onToggle(s.line)}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-expanded={!isFolded}
                aria-label={`${isFolded ? 'Unfold' : 'Fold'} ${s.name}`}
              >
                <ChevronRight className={`size-3.5 motion-safe:transition-transform ${isFolded ? '' : 'rotate-90'}`} />
              </button>
              <button
                type="button"
                onClick={() => onGo(s.line)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-current={s.line === current ? 'location' : undefined}
              >
                {s.line === running && <span className="log-live-dot size-1.5 shrink-0 rounded-full bg-info" aria-hidden />}
                <span className={`min-w-0 flex-1 truncate ${s.errors ? 'font-medium text-foreground' : 'text-foreground/90'}`} title={s.name}>
                  {s.name}
                </span>
                {s.line === running && <span className="sr-only">(running)</span>}
                {s.errors > 0 ? (
                  <span className="flex shrink-0 items-center gap-0.5 text-destructive tabular-nums">
                    <TriangleAlert className="size-3" aria-hidden />
                    {s.errors}
                    <span className="sr-only">{s.errors === 1 ? 'error' : 'errors'}</span>
                  </span>
                ) : s.warnings > 0 ? (
                  <span className="flex shrink-0 items-center gap-0.5 text-warning tabular-nums">
                    <TriangleAlert className="size-3" aria-hidden />
                    {s.warnings}
                    <span className="sr-only">{s.warnings === 1 ? 'warning' : 'warnings'}</span>
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
