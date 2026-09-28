import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { Maximize2, Minus, Plus } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import type { MapNode } from './tree.ts'

/** A node as laid out: pruned for display, but still knowing its real size. */
type LaidOutNode = MapNode & { childCount: number }

const ROW = 26
const COL = 330
const PADDING = 48
/** Below this, labels stop being readable, so auto-fit stops shrinking. */
const MIN_READABLE = 0.8

type Props = {
  root: MapNode
  expanded: Set<string>
  onToggle: (id: string) => void
  focusId?: string | null
  /** Changing this refits the view — used when the filters change the shape. */
  fitKey?: string
}

export function MindMap({ root, expanded, onToggle, focusId, fitKey }: Props) {
  const navigate = useNavigate()
  const svgRef = useRef<SVGSVGElement>(null)
  const contentRef = useRef<SVGGElement>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity)

  // Only expanded branches are laid out. Pruning drops `children`, so the
  // count is carried separately — otherwise a collapsed node looks like a leaf
  // and loses its toggle.
  const laidOut = useMemo(() => {
    const prune = (node: MapNode): LaidOutNode => ({
      ...node,
      childCount: node.children?.length ?? 0,
      children: expanded.has(node.id) ? node.children?.map(prune) : undefined,
    })
    return tree<LaidOutNode>().nodeSize([ROW, COL])(hierarchy(prune(root)))
  }, [root, expanded])

  const nodes = laidOut.descendants()
  const links = laidOut.links()

  useEffect(() => {
    if (!svgRef.current) return
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 2.5])
      .on('zoom', (event) => setTransform(event.transform))
    zoomRef.current = behaviour
    const selection = select(svgRef.current)
    selection.call(behaviour)
    return () => {
      selection.on('.zoom', null)
    }
  }, [])

  const applyTransform = useCallback((next: ZoomTransform) => {
    if (!svgRef.current || !zoomRef.current) return
    select(svgRef.current).call(zoomRef.current.transform, next)
  }, [])

  /**
   * Brings the tree into view.
   *
   * `automatic` refuses to shrink past MIN_READABLE: a filtered result that
   * technically fits but renders at 6px is worse than one you scroll through.
   * Pressing the button asks for the whole shape and gets it, however small.
   */
  const fit = useCallback(
    (automatic = false) => {
      const svg = svgRef.current
      const content = contentRef.current
      if (!svg || !content) return

      const view = svg.getBoundingClientRect()
      const box = content.getBBox()
      if (box.width === 0 || box.height === 0) return

      const whole = Math.min(
        (view.width - PADDING * 2) / box.width,
        (view.height - PADDING * 2) / box.height,
        1.1,
      )
      const scale = automatic ? Math.max(whole, MIN_READABLE) : whole

      // Left-anchored: the tree grows rightwards, so centring it horizontally
      // leaves a void where the root should be. Taller than the viewport, it
      // anchors to the top too, so reading starts at the first result.
      const overflows = box.height * scale > view.height - PADDING * 2
      applyTransform(
        zoomIdentity
          .translate(
            PADDING - box.x * scale,
            overflows ? PADDING - box.y * scale : view.height / 2 - (box.y + box.height / 2) * scale,
          )
          .scale(scale),
      )
    },
    [applyTransform],
  )

  // Refit when the shape changes out from under the viewport.
  useEffect(() => {
    const frame = requestAnimationFrame(() => fit(true))
    return () => cancelAnimationFrame(frame)
  }, [fit, fitKey])

  const scaleBy = useCallback(
    (factor: number) => {
      if (!svgRef.current || !zoomRef.current) return
      select(svgRef.current).call(zoomRef.current.scaleBy, factor)
    },
    [],
  )

  useEffect(() => {
    if (!focusId || !svgRef.current) return
    const target = nodes.find((node) => node.data.id === focusId)
    if (!target) return
    const { width, height } = svgRef.current.getBoundingClientRect()
    const scale = Math.max(transform.k, 0.8)
    applyTransform(
      zoomIdentity
        .translate(width / 3 - target.y * scale, height / 2 - target.x * scale)
        .scale(scale),
    )
    // Only when the focus changes; re-running on pan would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  function activate(node: HierarchyPointNode<LaidOutNode>) {
    if (node.data.href) navigate(node.data.href)
    else if (node.data.childCount > 0) onToggle(node.data.id)
  }

  return (
    <div className="relative h-[calc(100dvh-18rem)] min-h-96 overflow-hidden rounded-md border bg-card">
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        role="tree"
        aria-label="Projects map"
      >
        <g
          ref={contentRef}
          transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}
        >
          {links.map((link) => {
            const midpoint = (link.source.y + link.target.y) / 2
            return (
              <path
                key={link.target.data.id}
                d={`M${link.source.y},${link.source.x} C${midpoint},${link.source.x} ${midpoint},${link.target.x} ${link.target.y},${link.target.x}`}
                // Fades in when a branch opens; kept paths keep their key and stay put.
                className="reveal fill-none stroke-border"
                strokeWidth={1}
              />
            )
          })}

          {nodes.map((node) => (
            <Node
              key={node.data.id}
              node={node}
              isOpen={expanded.has(node.data.id)}
              isFocused={node.data.id === focusId}
              onToggle={onToggle}
              onActivate={activate}
            />
          ))}
        </g>
      </svg>

      <div className="absolute top-3 right-3 flex flex-col gap-1 rounded-md border bg-background/90 p-1 backdrop-blur">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => scaleBy(1.3)} aria-label="Zoom in" title="Zoom in">
          <Plus />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => scaleBy(1 / 1.3)} aria-label="Zoom out" title="Zoom out">
          <Minus />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => fit()} aria-label="Fit to view" title="Fit to view">
          <Maximize2 />
        </Button>
      </div>
    </div>
  )
}

function Node({
  node,
  isOpen,
  isFocused,
  onToggle,
  onActivate,
}: {
  node: HierarchyPointNode<LaidOutNode>
  isOpen: boolean
  isFocused: boolean
  onToggle: (id: string) => void
  onActivate: (node: HierarchyPointNode<LaidOutNode>) => void
}) {
  const hasChildren = node.data.childCount > 0
  const { kind, label, meta, href } = node.data

  return (
    <g
      transform={`translate(${node.y},${node.x})`}
      role="treeitem"
      aria-expanded={hasChildren ? isOpen : undefined}
      aria-label={label}
      tabIndex={0}
      className="reveal focus:outline-none [&:focus-visible>text]:underline"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onActivate(node)
        }
      }}
    >
      {isFocused && <circle r={9} className="fill-none stroke-primary" strokeWidth={1.5} />}
      {/* Filled means there is more inside; hollow means open or a leaf. */}
      <circle
        r={4.5}
        strokeWidth={1.5}
        className={
          isFocused
            ? 'cursor-pointer fill-primary stroke-primary'
            : hasChildren && !isOpen
              ? 'cursor-pointer fill-foreground stroke-foreground'
              : hasChildren
                ? 'cursor-pointer fill-card stroke-foreground'
                : 'fill-card stroke-muted-foreground'
        }
        onClick={() => hasChildren && onToggle(node.data.id)}
      />
      <text
        x={10}
        dy="0.32em"
        className={[
          'select-none',
          href ? 'cursor-pointer hover:underline' : hasChildren ? 'cursor-pointer' : 'cursor-default',
          kind === 'bucket'
            ? 'fill-foreground text-[15px] font-semibold'
            : kind === 'root' || kind === 'system'
              ? 'fill-foreground text-[13px] font-medium'
              : kind === 'application'
                ? 'fill-foreground text-[13px]'
                : 'fill-muted-foreground text-[12px]',
        ].join(' ')}
        onClick={() => onActivate(node)}
      >
        {label}
        {meta && <tspan className="fill-muted-foreground text-[11px]"> · {meta}</tspan>}
      </text>
    </g>
  )
}
