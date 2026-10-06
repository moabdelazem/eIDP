import { useMemo, useState, type CSSProperties } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type BuiltInEdge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Ban, Check, Loader2, X } from 'lucide-react'
import { duration, type Stage } from './api.ts'
import { RESULT } from './result.tsx'

/**
 * A pipeline drawn the way Jenkins' Pipeline Graph View draws it: a track
 * from Start to End, each stage a status circle on it with its name and time
 * beneath, and a parallel stage's branches leaving the track on rounded
 * elbows, one row each, and rejoining it before the next stage.
 *
 * The canvas is React Flow (`@xyflow/react`): pan by dragging, zoom with the
 * controls (or the wheel, in the large view), fit to view. The layout is ours —
 * a pipeline is a row of columns, not a graph to be guessed at — and the
 * rounded elbows are its `smoothstep` edges, meeting at an invisible junction
 * between columns so a fork or a join is drawn once, not once per pair.
 *
 * Lazy-loaded with React Flow's ~50 KB, like the charts: only a build page
 * needs it. Motion (`index.css`, all under `no-preference`): stages arrive in
 * column order, the running stage pulses, a line into it marches. A stage that
 * never ran is a dashed ring reached by a dashed line.
 *
 * A stage whose heading the log carries is a button that opens the log there;
 * one the log does not show (cut, or never reached) is not.
 */

const SIZES = {
  inline: { col: 124, row: 88, circle: 28, label: 116, head: 26, minH: 220, maxH: 460 },
  large: { col: 196, row: 112, circle: 38, label: 176, head: 32, minH: 0, maxH: 0 },
} as const
type Size = (typeof SIZES)[keyof typeof SIZES]

/** How long one column waits for the one before it, in ms — `--step` for `index.css`. */
const STEP = 90

type StageData = {
  stage: Stage
  parent: Stage | null
  column: number
  s: Size
  open: (() => void) | null
  selected: boolean
  onSelect: () => void
}
type EndData = { label: string; done: boolean; column: number; s: Size }
type HeadData = { name: string; count: number; column: number; s: Size }

export function StageGraph({
  stages,
  onOpen,
  size = 'inline',
}: {
  stages: Stage[]
  onOpen?: (stage: Stage, parent: Stage | null) => (() => void) | null
  size?: keyof typeof SIZES
}) {
  const s = SIZES[size]
  const [picked, setPicked] = useState<string | null>(null)
  const { nodes, edges, height } = useMemo(() => layout(stages, s, onOpen, picked, setPicked), [stages, s, onOpen, picked])
  const large = size === 'large'

  return (
    <div
      className={`stage-graph relative w-full ${large ? 'h-full min-h-[60vh]' : 'rounded-lg border bg-muted/20'}`}
      style={large ? undefined : { height: Math.min(s.maxH, Math.max(s.minH, height + 48)) }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        // Never shrunk past legible: a long pipeline is panned (drag) rather than squeezed into the card.
        fitViewOptions={{ padding: 0.08, maxZoom: 1, minZoom: large ? 0.3 : 0.85 }}
        minZoom={0.3}
        maxZoom={1.75}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        // Inline, the wheel scrolls the page as it always did; the controls zoom. Large, the wheel zooms.
        zoomOnScroll={large}
        preventScrolling={large}
        proOptions={{ hideAttribution: true }}
        aria-label="Pipeline stages"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  )
}

const nodeTypes = { stage: StageNode, end: EndNode, head: HeadNode, junction: JunctionNode }

/**
 * Columns left to right: Start, each stage (its branches stacked, the first
 * on the track), End. Between two columns, an invisible junction on the track
 * when either side has several nodes: everything on the left meets there, and
 * fans out from there to everything on the right.
 */
function layout(
  stages: Stage[],
  s: Size,
  onOpen: ((stage: Stage, parent: Stage | null) => (() => void) | null) | undefined,
  picked: string | null,
  setPicked: (key: string) => void,
): { nodes: Node[]; edges: BuiltInEdge[]; height: number } {
  const top = stages.some((st) => st.branches.length) ? s.head : 0
  const trackY = top + s.circle / 2
  const x = (col: number) => col * s.col
  const finished = stages.length > 0 && stages.every((st) => st.result !== 'running')
  const nodes: Node[] = []
  const edges: BuiltInEdge[] = []

  // Each column: the ids of its nodes and the result each was reached with.
  type Slot = { id: string; result: Stage['result'] }
  const columns: Slot[][] = []

  nodes.push({ id: 'start', type: 'end', position: { x: x(0) - s.label / 2, y: top }, data: { label: 'Start', done: true, column: 0, s } satisfies EndData })
  columns.push([{ id: 'start', result: 'success' }])

  stages.forEach((stage, i) => {
    const col = i + 1
    const rows = stage.branches.length ? stage.branches.map((b) => ({ stage: b, parent: stage })) : [{ stage, parent: null }]
    if (stage.branches.length) {
      nodes.push({ id: `head-${i}`, type: 'head', position: { x: x(col) - s.label / 2, y: 0 }, data: { name: stage.name, count: rows.length, column: col, s } satisfies HeadData })
    }
    columns.push(
      rows.map(({ stage: st, parent }, row) => {
        const id = `s-${i}-${row}`
        nodes.push({
          id,
          type: 'stage',
          position: { x: x(col) - s.label / 2, y: top + row * s.row },
          // React Flow turns pointer events off on a node that can be neither dragged nor selected;
          // a stage is a button, so it takes them back — or the pane under it catches the click.
          style: { pointerEvents: 'all' },
          data: {
            stage: st,
            parent,
            column: col,
            s,
            open: onOpen?.(st, parent) ?? null,
            selected: picked === id,
            onSelect: () => setPicked(id),
          } satisfies StageData,
        })
        return { id, result: st.result }
      }),
    )
  })

  const end = stages.length + 1
  nodes.push({ id: 'end', type: 'end', position: { x: x(end) - s.label / 2, y: top }, data: { label: 'End', done: finished, column: end, s } satisfies EndData })
  columns.push([{ id: 'end', result: finished ? 'success' : 'not_built' }])

  const edge = (source: string, target: string, into: Stage['result']): BuiltInEdge => ({
    id: `${source}->${target}`,
    source,
    target,
    type: 'smoothstep',
    pathOptions: { borderRadius: 14 },
    animated: into === 'running',
    className: into === 'not_built' ? 'stage-edge-skipped' : into === 'running' ? 'stage-edge-live' : 'stage-edge',
  })

  columns.forEach((left, i) => {
    const right = columns[i + 1]
    if (!right) return
    // How far the run got into the right-hand column decides how its lines look.
    if (left.length === 1 && right.length === 1) {
      edges.push(edge(left[0]!.id, right[0]!.id, right[0]!.result))
      return
    }
    const j = `j-${i}`
    // Its 1px handle's centre is half a pixel in: set back by that, so the fork leaves the track dead level.
    nodes.push({ id: j, type: 'junction', position: { x: x(i) + s.col / 2 - 0.5, y: trackY - 0.5 }, data: {} })
    const reached = right.some((r) => r.result !== 'not_built') ? (right.some((r) => r.result === 'running') ? 'running' : 'success') : 'not_built'
    for (const l of left) edges.push(edge(l.id, j, reached === 'not_built' ? 'not_built' : l.result === 'not_built' ? 'not_built' : 'success'))
    for (const r of right) edges.push(edge(j, r.id, r.result))
  })

  const rows = Math.max(1, ...stages.map((st) => st.branches.length || 1))
  return { nodes, edges, height: top + (rows - 1) * s.row + s.circle + 44 }
}

/** The handles sit on the circle's left and right edges, on its centre line, so lines touch the circle itself. */
function Handles({ s, size }: { s: Size; size: number }) {
  const top = size / 2
  const side = (s.label - size) / 2
  const style = (edge: 'left' | 'right'): CSSProperties => ({ top, [edge]: side, opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 })
  return (
    <>
      <Handle type="target" position={Position.Left} style={style('left')} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={style('right')} isConnectable={false} />
    </>
  )
}

const CIRCLE: Record<Stage['result'], string> = {
  success: 'border-success bg-success text-background',
  failure: 'border-destructive bg-destructive text-background',
  unstable: 'border-warning bg-warning text-background',
  running: 'graph-pulse border-info bg-info-soft text-info',
  aborted: 'border-muted-foreground/60 bg-muted-foreground/60 text-background',
  not_built: 'border-dashed border-muted-foreground/45 bg-background text-muted-foreground',
}

function StageNode({ data }: NodeProps<Node<StageData>>) {
  const { stage, parent, column, s, open, selected, onSelect } = data
  const { label } = RESULT[stage.result]
  const skipped = stage.result === 'not_built'
  const time = skipped ? 'Did not run' : stage.durationMs ? duration(stage.durationMs) : label
  const name = parent ? `${parent.name} › ${stage.name}` : stage.name
  const where = [stage.agent && `on ${stage.agent}`, stage.startedAt && `started ${new Date(stage.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`]
    .filter(Boolean)
    .join(', ')
  const glyph = s.circle >= 36 ? 'size-[18px]' : 'size-3.5'
  const Glyph = stage.result === 'success' ? Check : stage.result === 'failure' ? X : stage.result === 'aborted' ? Ban : stage.result === 'running' ? Loader2 : null
  const circle = (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full border-2 transition-shadow ${CIRCLE[stage.result]} ${selected ? 'ring-[3px] ring-ring/60 ring-offset-2 ring-offset-background' : ''}`}
      style={{ width: s.circle, height: s.circle }}
      aria-hidden
    >
      {Glyph ? (
        <Glyph className={`${glyph} ${stage.result === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={3} />
      ) : stage.result === 'unstable' ? (
        <span className="text-sm leading-none font-bold">!</span>
      ) : null}
    </span>
  )
  const text = (
    <>
      <span className={`mt-2 block w-full truncate font-medium ${s.circle >= 36 ? 'text-sm' : 'text-xs'} ${stage.result === 'failure' ? 'text-destructive' : skipped ? 'text-muted-foreground' : ''}`}>
        {stage.name}
      </span>
      <span className="block w-full truncate text-xs text-muted-foreground tabular-nums">{time}</span>
      {s.circle >= 36 && where && !skipped && <span className="block w-full truncate font-mono text-[11px] text-muted-foreground">{stage.agent ?? ''}</span>}
    </>
  )
  const body = (
    <>
      {circle}
      {text}
    </>
  )
  return (
    <div className="graph-fade relative flex flex-col items-center text-center" style={{ width: s.label, '--i': column, '--step': `${STEP}ms` } as CSSProperties}>
      <Handles s={s} size={s.circle} />
      {open ? (
        <button
          type="button"
          onClick={() => {
            onSelect()
            open()
          }}
          className="nodrag nopan group flex w-full cursor-pointer flex-col items-center rounded-lg px-1 pb-1 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`${name}: ${skipped ? 'did not run' : `${label}${stage.durationMs ? `, ${duration(stage.durationMs)}` : ''}`}${where ? `, ${where}` : ''}. Show it in the log`}
          title={`${name} — ${label}${where ? ` · ${where}` : ''}. Show it in the log`}
        >
          {body}
        </button>
      ) : (
        <div className="flex w-full flex-col items-center px-1 pb-1" title={`${name} — ${skipped ? 'did not run' : label}`} aria-label={`${name}: ${skipped ? 'did not run' : label}`}>
          {body}
        </div>
      )}
    </div>
  )
}

/** Start and End: small grey markers on the track, End hollow while the run goes on. */
function EndNode({ data }: NodeProps<Node<EndData>>) {
  const { label, done, column, s } = data
  const dot = Math.round(s.circle * 0.5)
  return (
    <div className="graph-fade relative flex flex-col items-center" style={{ width: s.label, '--i': column, '--step': `${STEP}ms` } as CSSProperties}>
      <Handles s={s} size={s.circle} />
      <span className="flex items-center justify-center" style={{ height: s.circle }} aria-hidden>
        <span className={`rounded-full border-2 ${done ? 'border-muted-foreground/60 bg-muted-foreground/60' : 'border-muted-foreground/45 bg-background'}`} style={{ width: dot, height: dot }} />
      </span>
      <span className="mt-2 text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

/** A parallel stage's name, above its branches. */
function HeadNode({ data }: NodeProps<Node<HeadData>>) {
  const { name, count, column, s } = data
  return (
    <div className="graph-fade truncate text-center text-xs font-medium text-muted-foreground" style={{ width: s.label, '--i': column, '--step': `${STEP}ms` } as CSSProperties} title={`${name}: ${count} branches in parallel`}>
      {name} <span className="font-normal">· {count} parallel</span>
    </div>
  )
}

/** Where a fork leaves the track and a join comes back to it: a point, drawn as nothing. */
function JunctionNode() {
  const style: CSSProperties = { top: 0, left: 0, opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, transform: 'none' }
  return (
    <div style={{ width: 1, height: 1 }}>
      <Handle type="target" position={Position.Left} style={style} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={style} isConnectable={false} />
    </div>
  )
}
