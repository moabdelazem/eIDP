import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { useNavigate } from 'react-router'
import type { MapNode } from './tree.ts'

/** A node as laid out: pruned for display, but still knowing its real size. */
type LaidOutNode = MapNode & { childCount: number }

const ROW = 26 // vertical gap between siblings
const COL = 330 // horizontal gap; system names run long, so give them room

type Props = {
  root: MapNode
  expanded: Set<string>
  onToggle: (id: string) => void
  /** Node to centre on, e.g. after a search hit. */
  focusId?: string | null
}

export function MindMap({ root, expanded, onToggle, focusId }: Props) {
  const navigate = useNavigate()
  const svgRef = useRef<SVGSVGElement>(null)
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
    const layout = tree<LaidOutNode>().nodeSize([ROW, COL])
    return layout(hierarchy(prune(root)))
  }, [root, expanded])

  const nodes = laidOut.descendants()
  const links = laidOut.links()

  useEffect(() => {
    if (!svgRef.current) return
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 2.5])
      .on('zoom', (event) => setTransform(event.transform))
    zoomRef.current = behaviour
    const selection = select(svgRef.current)
    selection.call(behaviour)
    // Start with the root on the left, vertically centred.
    const { height } = svgRef.current.getBoundingClientRect()
    selection.call(behaviour.transform, zoomIdentity.translate(80, height / 2))
    return () => {
      selection.on('.zoom', null)
    }
  }, [])

  const centreOn = useCallback((node: HierarchyPointNode<LaidOutNode>) => {
    if (!svgRef.current || !zoomRef.current) return
    const { width, height } = svgRef.current.getBoundingClientRect()
    // Jumps rather than glides: a tween would need d3-transition, and it would
    // have to be suppressed for prefers-reduced-motion anyway.
    select(svgRef.current).call(
      zoomRef.current.transform,
      zoomIdentity.translate(width / 3 - node.y, height / 2 - node.x),
    )
  }, [])

  useEffect(() => {
    if (!focusId) return
    const target = nodes.find((node) => node.data.id === focusId)
    if (target) centreOn(target)
  }, [focusId, nodes, centreOn])

  function activate(node: HierarchyPointNode<LaidOutNode>) {
    if (node.data.href) navigate(node.data.href)
    else if (node.data.childCount > 0) onToggle(node.data.id)
  }

  return (
    <div className="relative h-[calc(100dvh-14rem)] min-h-96 overflow-hidden rounded-md border bg-card">
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        role="tree"
        aria-label="Project map"
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {links.map((link) => {
            const midpoint = (link.source.y + link.target.y) / 2
            return (
              <path
                key={link.target.data.id}
                d={`M${link.source.y},${link.source.x} C${midpoint},${link.source.x} ${midpoint},${link.target.x} ${link.target.y},${link.target.x}`}
                className="fill-none stroke-border"
                strokeWidth={1}
              />
            )
          })}

          {nodes.map((node) => {
            const hasChildren = node.data.childCount > 0
            const isOpen = expanded.has(node.data.id)
            const isFocused = node.data.id === focusId
            return (
              <g
                key={node.data.id}
                transform={`translate(${node.y},${node.x})`}
                role="treeitem"
                aria-expanded={hasChildren ? isOpen : undefined}
                aria-label={node.data.label}
                tabIndex={0}
                className="focus:outline-none [&:focus-visible>text]:underline"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activate(node)
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
                    node.data.href ? 'cursor-pointer hover:underline' : 'cursor-default',
                    node.data.kind === 'root' || node.data.kind === 'system'
                      ? 'fill-foreground text-[13px] font-medium'
                      : node.data.kind === 'application'
                        ? 'fill-foreground text-[13px]'
                        : 'fill-muted-foreground text-[12px]',
                  ].join(' ')}
                  onClick={() => activate(node)}
                >
                  {node.data.label}
                  {node.data.meta && (
                    <tspan className="fill-muted-foreground text-[11px]"> · {node.data.meta}</tspan>
                  )}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
