import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { hierarchy, tree } from 'd3-hierarchy'
import { cn } from 'cn'
import { Boxes, ChevronsDownUp, ChevronsUpDown, Info, Maximize2, Minus, Plus } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EnvPills, Highlight, TechTag } from './map-parts.tsx'
import { pathTo, type MapNode } from './tree.ts'

/**
 * The projects map's canvas: the organization on the left, its systems, their
 * applications — each a card you can read, not a dot with a label. React Flow
 * (`@xyflow/react`, shared with the build page's stage graph and loaded with
 * this page alone) draws, pans, zooms and culls what is off screen
 * (`onlyRenderVisibleElements`), which keeps ~1100 applications usable; the
 * layout is ours (`d3-hierarchy`), a tree read left to right.
 *
 * Choosing a card selects it (the panel beside the map says what it is); a
 * system chosen while closed opens too. The round button on a card's edge
 * opens or closes it without choosing. The line from the root to what is
 * chosen is drawn in the ring colour, so where it sits in the organization
 * shows at a glance.
 *
 * Only expanded branches are laid out. Pruning drops `children`, so the
 * count is carried alongside — otherwise a closed system looks like a leaf
 * and loses its button.
 */

type Laid = MapNode & { childCount: number }

/** Each kind's card. Heights set the row; widths stay under the column. */
const SIZE: Record<MapNode['kind'], { w: number; h: number }> = {
  root: { w: 232, h: 64 },
  bucket: { w: 112, h: 52 },
  system: { w: 264, h: 60 },
  application: { w: 284, h: 62 },
}
const ROW = 74
const COL = 304
const PAD = 40
/** Below this, card text stops being readable, so the automatic fit stops shrinking. */
const MIN_READABLE = 0.8

type CardData = {
  node: Laid
  open: boolean
  selected: boolean
  onPath: boolean
  query: string
  onToggle: (id: string) => void
  onSelect: (id: string) => void
}
type MapCard = Node<CardData, MapNode['kind']>

type Props = {
  root: MapNode
  expanded: Set<string>
  selected: string | null
  query: string
  /** Changing this refits the view — the filters changed the shape. */
  fitKey: string
  /** Changing this centres the chosen card ("Show on map", a link that chose it). */
  focusKey: number
  onToggle: (id: string) => void
  onSelect: (id: string | null) => void
  onExpandAll: () => void
  onCollapseAll: () => void
}

export function FlowMap(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({ root, expanded, selected, query, fitKey, focusKey, onToggle: toggleBranch, onSelect, onExpandAll, onCollapseAll }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const flow = useReactFlow()
  // A branch just opened by hand: once it is laid out, its children are brought into view (below).
  const opened = useRef<string | null>(null)
  // The page's callbacks change every render; the cards get stable ones that read the latest, so choosing one card does not redraw them all.
  const latest = useRef({ expanded, toggleBranch, onSelect })
  useEffect(() => {
    latest.current = { expanded, toggleBranch, onSelect }
  })
  const onToggle = useCallback((id: string) => {
    opened.current = latest.current.expanded.has(id) ? null : id
    latest.current.toggleBranch(id)
  }, [])
  const choose = useCallback((id: string) => latest.current.onSelect(id), [])
  // Open all and Close all change the whole shape: they refit, as a filter does.
  const [shape, setShape] = useState(0)

  // The layout: only when the shape changes (filters, a branch opened or closed) — never for a choice.
  const laid = useMemo(() => {
    const prune = (node: MapNode): Laid => ({
      ...node,
      childCount: node.children?.length ?? 0,
      children: expanded.has(node.id) ? node.children?.map(prune) : undefined,
    })
    return tree<Laid>()
      .nodeSize([ROW, COL])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.25))(hierarchy(prune(root)))
  }, [root, expanded])

  /**
   * The cards and lines, decorated with what is chosen. A card whose place
   * and look did not change keeps the very same object, which is how React
   * Flow knows to leave it alone: choosing a card redraws that card and the
   * path to it, not the 1,500 on the map.
   */
  const cache = useRef(new Map<string, { sig: string; card: MapCard }>())
  const lines = useRef(new Map<string, Edge>())
  const { nodes, edges } = useMemo(() => {
    const lit = new Set(selected ? (pathTo(root, selected) ?? []) : [])
    const nextCache = new Map<string, { sig: string; card: MapCard }>()
    const nodes: MapCard[] = laid.descendants().map((d) => {
      const size = SIZE[d.data.kind]
      const x = d.y, y = d.x - size.h / 2
      const open = expanded.has(d.data.id), chosen = d.data.id === selected, onPath = lit.has(d.data.id)
      const sig = [x, y, open, chosen, onPath, query, d.data.label, d.data.meta, d.data.childCount, d.data.app?.environments.join()].join('|')
      const prev = cache.current.get(d.data.id)
      const card =
        prev && prev.sig === sig
          ? prev.card
          : {
              id: d.data.id,
              type: d.data.kind,
              position: { x, y },
              width: size.w,
              height: size.h,
              data: { node: d.data, open, selected: chosen, onPath, query, onToggle, onSelect: choose },
              draggable: false,
              selectable: false,
              focusable: false,
            }
      nextCache.set(d.data.id, { sig, card })
      return card
    })
    cache.current = nextCache
    const nextLines = new Map<string, Edge>()
    const edges: Edge[] = laid.links().map((link) => {
      const id = `e:${link.target.data.id}`
      const className = lit.has(link.target.data.id) ? 'map-edge map-edge-lit' : 'map-edge'
      const prev = lines.current.get(id)
      const edge = prev && prev.source === link.source.data.id && prev.className === className ? prev : { id, source: link.source.data.id, target: link.target.data.id, className, focusable: false, selectable: false }
      nextLines.set(id, edge)
      return edge
    })
    lines.current = nextLines
    return { nodes, edges }
  }, [laid, root, expanded, selected, query, onToggle, choose])

  /**
   * Brings the tree into view. `automatic` refuses to shrink past
   * MIN_READABLE: a result that technically fits but renders at 6px is worse
   * than one you pan through. Asking (the fit button) gets the whole shape,
   * however small. Left-anchored, because the tree grows rightwards; taller
   * than the view, it anchors to the top so reading starts at the first card.
   */
  const fit = useCallback(
    (automatic: boolean) => {
      const view = box.current?.getBoundingClientRect()
      if (!view || nodes.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) {
        minX = Math.min(minX, n.position.x)
        minY = Math.min(minY, n.position.y)
        maxX = Math.max(maxX, n.position.x + (n.width ?? 0))
        maxY = Math.max(maxY, n.position.y + (n.height ?? 0))
      }
      const width = maxX - minX, height = maxY - minY
      const whole = Math.min((view.width - PAD * 2) / width, (view.height - PAD * 2) / height, 1.05)
      const zoom = automatic ? Math.max(whole, MIN_READABLE) : whole
      // Narrower than the view: centred. Wider: anchored at the root, which is where reading starts.
      const x = width * zoom <= view.width - PAD * 2 ? (view.width - width * zoom) / 2 - minX * zoom : PAD - minX * zoom
      const y = height * zoom > view.height - PAD * 2 ? PAD - minY * zoom : view.height / 2 - (minY + height / 2) * zoom
      void flow.setViewport({ x, y, zoom }, { duration: motionMs(260) })
    },
    [flow, nodes],
  )

  // Refit when the filters change the shape — not on every open or close, which would yank the view from under the reader.
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const frame = requestAnimationFrame(() => fitRef.current(true))
    return () => cancelAnimationFrame(frame)
  }, [fitKey, shape])

  /**
   * A branch opened by hand pushes its children a column to the right, often
   * off screen. Pan — never zoom — just enough to show the branch and its
   * children, the branch kept on screen first: the reader's eye is on it.
   */
  useEffect(() => {
    const id = opened.current
    opened.current = null
    const view = box.current?.getBoundingClientRect()
    if (!id || !view) return
    const branch = nodes.find((n) => n.id === id)
    const kids = edges.filter((e) => e.source === id).map((e) => nodes.find((n) => n.id === e.target)!).filter(Boolean)
    if (!branch || kids.length === 0) return
    const { x, y, zoom } = flow.getViewport()
    const all = [branch, ...kids]
    const left = Math.min(...all.map((n) => n.position.x)) * zoom + x
    const right = Math.max(...all.map((n) => n.position.x + (n.width ?? 0))) * zoom + x
    const top = Math.min(...all.map((n) => n.position.y)) * zoom + y
    const bottom = Math.max(...all.map((n) => n.position.y + (n.height ?? 0))) * zoom + y
    let dx = 0, dy = 0
    if (right > view.width - PAD) dx = view.width - PAD - right
    if (left + dx < PAD) dx = PAD - left
    if (bottom > view.height - PAD) dy = view.height - PAD - bottom
    if (top + dy < PAD) dy = PAD - top
    if (dx || dy) void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: motionMs(260) })
  }, [nodes, edges, flow])

  // Centre the chosen card when asked to.
  useEffect(() => {
    if (!focusKey || !selected) return
    const frame = requestAnimationFrame(() => {
      const target = nodes.find((n) => n.id === selected)
      if (!target) return
      const zoom = Math.max(flow.getZoom(), 0.9)
      void flow.setCenter(target.position.x + (target.width ?? 0) / 2, target.position.y + (target.height ?? 0) / 2, { zoom, duration: motionMs(320) })
    })
    return () => cancelAnimationFrame(frame)
    // Only when asked: following every relayout would fight someone panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  return (
    <div ref={box} className="project-map relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onlyRenderVisibleElements
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.1}
        maxZoom={2.5}
        onPaneClick={() => onSelect(null)}
        // The cards' own buttons do the work; a node handler is what tells React Flow to let clicks reach a node that is neither draggable nor selectable.
        onNodeClick={noop}
        proOptions={{ hideAttribution: true }}
        aria-label="Projects map"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Panel position="top-left" className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="bg-card"
            onClick={() => {
              onExpandAll()
              setShape((n) => n + 1)
            }}
          >
            <ChevronsUpDown /> Open all
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="bg-card"
            onClick={() => {
              onCollapseAll()
              setShape((n) => n + 1)
            }}
          >
            <ChevronsDownUp /> Close all
          </Button>
          {/* The key, on demand: always on screen it sat over the cards in its corner. */}
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="bg-card">
                <Info /> Key
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 text-xs text-muted-foreground">
              <Legend />
            </PopoverContent>
          </Popover>
        </Panel>
        <Panel position="top-right" className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-xs">
          <ZoomButton label="Zoom in" onClick={() => void flow.zoomIn({ duration: motionMs(160) })}>
            <Plus />
          </ZoomButton>
          <ZoomButton label="Zoom out" onClick={() => void flow.zoomOut({ duration: motionMs(160) })}>
            <Minus />
          </ZoomButton>
          <ZoomButton label="Fit everything shown" onClick={() => fit(false)}>
            <Maximize2 />
          </ZoomButton>
        </Panel>
        <MiniMap
          className="!hidden lg:!block"
          pannable
          zoomable
          ariaLabel="Overview of the map"
          style={{ width: 168, height: 112 }}
          nodeBorderRadius={6}
          nodeColor={(n) => (n.type === 'application' ? 'var(--map-mini-app)' : 'var(--map-mini-branch)')}
        />
      </ReactFlow>
    </div>
  )
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8 rounded-none" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}

/** What the shapes mean — a map needs its key. */
function Legend() {
  return (
    <ul className="flex flex-col gap-1.5">
      <li className="flex items-center gap-2">
        <span aria-hidden className="h-3 w-4 rounded-sm border border-l-[3px] border-l-[var(--chart-1)] bg-card" /> System
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className="h-3 w-4 rounded-sm border bg-card" /> Application
      </li>
      <li className="flex items-center gap-2">
        <EnvPills environments={['prd']} size="xs" /> Runs in production
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--chart-1)] px-1 text-[10px] font-semibold text-white">7</span> Closed: how many inside
      </li>
      <li className="pt-1 leading-relaxed">Choose a card to see it beside the map; double-click an application to open it. Drag to move, scroll to zoom.</li>
    </ul>
  )
}

const noop = () => {}

/** The milliseconds a view change takes — none for anyone who asked for less motion. */
function motionMs(ms: number): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
}

// ---- the cards ---------------------------------------------------------------

/** The round button on a card's right edge: how many are inside, and whether they show. */
function Toggle({ node, open, onToggle }: { node: Laid; open: boolean; onToggle: (id: string) => void }) {
  if (node.childCount === 0) return null
  const noun = node.kind === 'system' ? (node.childCount === 1 ? 'application' : 'applications') : node.childCount === 1 ? 'system' : 'systems'
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onToggle(node.id)
      }}
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} ${node.childCount} ${noun} in ${node.label}`}
      className={cn(
        'nodrag nopan absolute top-1/2 -right-3 z-10 flex h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded-full border px-1.5 text-[11px] font-semibold tabular-nums shadow-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        open ? 'bg-card text-muted-foreground hover:text-foreground' : 'border-[var(--chart-1)] bg-[var(--chart-1)] text-white hover:opacity-90',
      )}
    >
      {open ? <Minus className="size-3" aria-hidden /> : node.childCount}
    </button>
  )
}

function Card({ data, className, children }: { data: CardData; className?: string; children: React.ReactNode }) {
  const navigate = useNavigate()
  const { node, open, selected, onPath, onToggle, onSelect } = data
  const choose = () => {
    if (node.kind === 'root' || node.kind === 'bucket') return onToggle(node.id)
    onSelect(node.id)
    // A system chosen while closed opens: you chose it to see what is in it.
    if (node.kind === 'system' && !open && node.childCount > 0) onToggle(node.id)
  }
  return (
    <div className="reveal relative h-full">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        onClick={choose}
        onDoubleClick={() => node.app && navigate(`/projects/${encodeURIComponent(node.app.id)}`)}
        aria-pressed={node.kind === 'system' || node.kind === 'application' ? selected : undefined}
        aria-expanded={node.kind === 'root' || node.kind === 'bucket' ? open : undefined}
        className={cn(
          'nodrag nopan flex h-full w-full flex-col justify-center rounded-lg border bg-card px-3 text-left shadow-xs transition-[box-shadow,border-color,background-color] hover:border-ring/50 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          onPath && !selected && 'border-ring/50',
          selected && 'border-ring ring-2 ring-ring/40',
          className,
        )}
      >
        {children}
      </button>
      <Toggle node={node} open={open} onToggle={onToggle} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

const RootCard = memo(function RootCard({ data }: NodeProps<MapCard>) {
  return (
    <Card data={data} className="border-rail-border bg-rail text-rail-foreground hover:border-sidebar-indicator">
      <span className="flex items-center gap-2">
        <Boxes className="size-4 shrink-0 text-sidebar-indicator" aria-hidden />
        <span className="font-display truncate text-[15px] font-semibold">{data.node.label}</span>
      </span>
      <span className="mt-0.5 text-xs text-rail-muted">{data.node.meta}</span>
    </Card>
  )
})

const BucketCard = memo(function BucketCard({ data }: NodeProps<MapCard>) {
  return (
    <Card data={data} className="items-start">
      <span className="font-display text-lg leading-none font-semibold">{data.node.label}</span>
      <span className="mt-1 text-[11px] text-muted-foreground">{data.node.meta}</span>
    </Card>
  )
})

const SystemCard = memo(function SystemCard({ data }: NodeProps<MapCard>) {
  const system = data.node.system!
  const technologies = new Set(system.applications.map((a) => a.buildTechnology).filter(Boolean)).size
  return (
    <Card data={data} className="border-l-[3px] border-l-[var(--chart-1)]">
      <span className="truncate text-[13px] font-semibold">
        <Highlight text={data.node.label} query={data.query} />
      </span>
      <span className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {data.node.meta}
        {technologies > 0 && ` · ${technologies} ${technologies === 1 ? 'technology' : 'technologies'}`}
      </span>
    </Card>
  )
})

const ApplicationCard = memo(function ApplicationCard({ data }: NodeProps<MapCard>) {
  const app = data.node.app!
  return (
    <Card data={data}>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[13px] font-medium">
          <Highlight text={app.name} query={data.query} />
        </span>
        <TechTag technology={app.buildTechnology} className="shrink-0" />
      </span>
      <EnvPills environments={app.environments} size="xs" className="mt-1.5" />
    </Card>
  )
})

const NODE_TYPES = { root: RootCard, bucket: BucketCard, system: SystemCard, application: ApplicationCard }
