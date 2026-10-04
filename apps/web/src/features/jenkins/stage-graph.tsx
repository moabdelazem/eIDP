import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { duration, type Stage } from './api.ts'
import { RESULT } from './result.tsx'

/**
 * A pipeline drawn as Jenkins' Pipeline Graph View draws it: stages left to
 * right, a stage's parallel branches stacked in its column under its name,
 * and lines that fan out to the branches and back in. Plain SVG lines under
 * absolutely placed HTML nodes, so the nodes stay buttons with real text and
 * the whole thing inherits the theme.
 *
 * Two sizes: `inline` on the build page, and `large` in the dialog it opens
 * into, with room for each stage's agent and start.
 *
 * Motion says what the pipeline did, in order (`index.css`, all of it under
 * `no-preference`): stages arrive column by column and the lines between them
 * draw in behind, so the eye follows the run; a line into a stage still
 * running keeps moving, and the running stage pulses — that is the one thing
 * on the page still changing. A stage that never ran is reached by a dashed
 * line. With reduced motion, all of it is simply there.
 *
 * A node whose heading the log carries is a button that opens the log there;
 * one the log does not show (cut, or never reached) is not.
 */

const SIZES = {
  // Nodes share the width there is, between these; past the narrowest, the box scrolls.
  inline: { minW: 136, maxW: 200, h: 56, colGap: 36, rowGap: 12, head: 22 },
  large: { minW: 176, maxW: 300, h: 78, colGap: 64, rowGap: 18, head: 28 },
} as const

/** How long one column waits for the one before it, in ms — set as `--step` for `index.css`. */
const STEP = 90

type Column = { stage: Stage; nodes: { stage: Stage; parent: Stage | null }[] }
type Line = { d: string; column: number; into: Stage['result'] }

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
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    // The content width: clientWidth counts the padding that keeps a pulse or a lifted node from clipping.
    const measure = () => {
      const style = getComputedStyle(el)
      setRoom(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  const columns: Column[] = stages.map((stage) => ({
    stage,
    nodes: stage.branches.length ? stage.branches.map((b) => ({ stage: b, parent: stage })) : [{ stage, parent: null }],
  }))
  // The large graph turns to run top to bottom where the stages will not sit side by side
  // (a phone): parallel branches then sit side by side instead, and nothing scrolls sideways.
  const vertical = size === 'large' && room > 0 && room < columns.length * s.minW + (columns.length - 1) * s.colGap
  const layout = vertical ? down(columns, room, s) : across(columns, room, s)

  // Out of every node of a column to the spine between columns, and from there into every node of the next.
  const lines: Line[] = []
  columns.forEach((_, i) => {
    const next = columns[i + 1]
    if (!next) return
    const from = layout.nodes.filter((n) => n.column === i)
    const to = layout.nodes.filter((n) => n.column === i + 1)
    // The half out of a column is as far as the next stage got.
    const reached = next.nodes.some((n) => n.stage.result !== 'not_built') ? next.stage.result : 'not_built'
    const spine = layout.spine(i)
    for (const n of from) lines.push({ d: curve(layout.exit(n), spine, vertical), column: i, into: reached })
    to.forEach((n, row) => lines.push({ d: curve(spine, layout.entry(n), vertical), column: i, into: next.nodes[row]!.stage.result }))
  })
  const { width, height } = layout

  return (
    // The box scrolls, never the page: a long pipeline is wider than a phone.
    <div ref={box} className={size === 'large' ? 'overflow-auto p-2' : 'overflow-x-auto px-1 pt-1 pb-2'}>
      <div className="relative mx-auto" style={{ width, height, ['--step' as string]: `${STEP}ms` }}>
        <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
          {lines.map((line, n) => (
            <path
              key={n}
              d={line.d}
              fill="none"
              strokeWidth={size === 'large' ? 2 : 1.5}
              // pathLength 1 lets the draw-in animate every curve over the same dash, whatever its length.
              pathLength={line.into === 'running' || line.into === 'not_built' ? undefined : 1}
              strokeDasharray={line.into === 'not_built' ? '4 5' : line.into === 'running' ? '6 6' : undefined}
              className={
                line.into === 'not_built'
                  ? 'stroke-muted-foreground/30'
                  : line.into === 'running'
                    ? 'graph-line-live stroke-info/70'
                    : 'graph-line stroke-muted-foreground/45'
              }
              style={{ '--i': line.column } as CSSProperties}
            />
          ))}
        </svg>
        {layout.heads.map((head) => (
          <p
            key={`head-${head.column}`}
            className={`graph-node absolute truncate font-medium text-muted-foreground ${size === 'large' ? 'text-sm' : 'text-xs'}`}
            style={{ left: head.x, top: head.y, width: head.w, '--i': head.column } as CSSProperties}
            title={columns[head.column]!.stage.name}
          >
            {columns[head.column]!.stage.name} <span className="font-normal">· parallel</span>
          </p>
        ))}
        <ol aria-label="Pipeline stages" className="contents">
          {layout.nodes.map((n) => {
            const { stage, parent } = columns[n.column]!.nodes[n.row]!
            return (
              <li
                key={`${n.column}-${n.row}`}
                className="graph-node absolute"
                style={{ left: n.x, top: n.y, width: n.w, height: n.h, '--i': n.column } as CSSProperties}
              >
                <Node stage={stage} parent={parent} large={size === 'large'} open={onOpen?.(stage, parent) ?? null} />
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

type Point = [x: number, y: number]
type Placed = { column: number; row: number; x: number; y: number; w: number; h: number }
type Layout = {
  width: number
  height: number
  nodes: Placed[]
  heads: { column: number; x: number; y: number; w: number }[]
  /** Where a column's lines meet before fanning into the next. */
  spine: (column: number) => Point
  exit: (node: Placed) => Point
  entry: (node: Placed) => Point
}
type Size = (typeof SIZES)[keyof typeof SIZES]

/** Left to right: a column per stage, its parallel branches stacked under its name. */
function across(columns: Column[], room: number, s: Size): Layout {
  const W = Math.round(Math.min(s.maxW, Math.max(s.minW, (room - (columns.length - 1) * s.colGap) / Math.max(columns.length, 1))))
  const head = columns.some((c) => c.stage.branches.length) ? s.head : 0
  const rows = Math.max(1, ...columns.map((c) => c.nodes.length))
  const x = (col: number) => col * (W + s.colGap)
  const y = (row: number) => head + row * (s.h + s.rowGap)
  return {
    width: columns.length * W + (columns.length - 1) * s.colGap,
    height: head + rows * s.h + (rows - 1) * s.rowGap,
    nodes: columns.flatMap((c, i) => c.nodes.map((_, row) => ({ column: i, row, x: x(i), y: y(row), w: W, h: s.h }))),
    heads: columns.flatMap((c, i) => (c.stage.branches.length ? [{ column: i, x: x(i), y: 0, w: W }] : [])),
    spine: (i) => [x(i) + W + s.colGap / 2, y(0) + s.h / 2],
    exit: (n) => [n.x + n.w, n.y + n.h / 2],
    entry: (n) => [n.x, n.y + n.h / 2],
  }
}

/** Top to bottom, for a narrow screen: a row per stage, its parallel branches side by side under its name. */
function down(columns: Column[], room: number, s: Size): Layout {
  const gap = 12
  const nodes: Placed[] = []
  const heads: Layout['heads'] = []
  const spines: number[] = []
  let top = 0
  columns.forEach((c, i) => {
    if (i > 0) {
      // A parallel stage's name sits at the top of the gap, left of the centre line the lines come
      // down, and they fan out below it — so no line runs through it.
      const named = c.stage.branches.length > 0
      if (named) heads.push({ column: i, x: 0, y: top + 4, w: room / 2 - 12 })
      const gapH = s.colGap + (named ? s.head : 0)
      spines.push(top + (named ? s.head : 0) + s.colGap / 2)
      top += gapH
    }
    const n = c.nodes.length
    const w = Math.min(s.maxW, (room - (n - 1) * gap) / n)
    const left = (room - (n * w + (n - 1) * gap)) / 2
    c.nodes.forEach((_, row) => nodes.push({ column: i, row, x: left + row * (w + gap), y: top, w, h: s.h }))
    top += s.h
  })
  return {
    width: room,
    height: top,
    nodes,
    heads,
    spine: (i) => [room / 2, spines[i]!],
    exit: (n) => [n.x + n.w / 2, n.y + n.h],
    entry: (n) => [n.x + n.w / 2, n.y],
  }
}

/** A cubic bezier between two points, bending along the direction the graph runs. */
function curve([x1, y1]: Point, [x2, y2]: Point, vertical: boolean): string {
  if (vertical) {
    const bend = (y2 - y1) / 2
    return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`
  }
  const bend = (x2 - x1) / 2
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
}

function Node({ stage, parent, large, open }: { stage: Stage; parent: Stage | null; large: boolean; open: (() => void) | null }) {
  const { icon: Icon, label, dot } = RESULT[stage.result]
  const tone =
    stage.result === 'failure'
      ? 'border-destructive/40 text-destructive'
      : stage.result === 'success'
        ? 'text-success'
        : stage.result === 'unstable'
          ? 'border-warning/40 text-warning'
          : stage.result === 'running'
            ? 'border-info/50 text-info'
            : 'text-muted-foreground'
  const skipped = stage.result === 'not_built'
  const detail = skipped ? 'Did not run' : `${label}${stage.durationMs ? ` · ${duration(stage.durationMs)}` : ''}`
  const name = parent ? `${parent.name} › ${stage.name}` : stage.name
  const where = [stage.agent && `on ${stage.agent}`, stage.startedAt && `at ${new Date(stage.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`]
    .filter(Boolean)
    .join(' ')
  const body = (
    <>
      <span className={`absolute inset-y-0 left-0 w-1 rounded-l-lg ${dot}`} aria-hidden />
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={`shrink-0 ${large ? 'size-[18px]' : 'size-4'} ${tone.split(' ').at(-1)} ${stage.result === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
        <span className={`truncate font-medium ${large ? 'text-base' : 'text-sm'}`}>{stage.name}</span>
      </span>
      <span className={`mt-0.5 block truncate text-muted-foreground ${large ? 'text-sm' : 'text-xs'}`}>{detail}</span>
      {large && !skipped && where && <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{where}</span>}
    </>
  )
  const border = tone.split(' ')[0]!.startsWith('border-') ? tone.split(' ')[0] : ''
  const box = `relative block size-full rounded-lg border bg-card py-2 pr-2.5 pl-3.5 text-left shadow-xs ${skipped ? 'border-dashed opacity-70' : ''} ${border} ${stage.result === 'running' ? 'graph-pulse' : ''}`
  return open ? (
    <button
      type="button"
      onClick={open}
      className={`${box} graph-lift transition-colors hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none`}
      aria-label={`${name}: ${detail}${where ? `, ${where}` : ''}. Show it in the log`}
      title={`${name} — show it in the log`}
    >
      {body}
    </button>
  ) : (
    <div className={box} aria-label={`${name}: ${detail}`} title={name}>
      {body}
    </div>
  )
}
