import { useLayoutEffect, useRef, useState } from 'react'
import { duration, type Stage } from './api.ts'
import { RESULT } from './result.tsx'

/**
 * A pipeline drawn as Jenkins' Pipeline Graph View draws it: stages left to
 * right, a stage's parallel branches stacked in its column under its name,
 * and lines that fan out to the branches and back in. Plain SVG lines under
 * absolutely placed HTML nodes, so the nodes stay buttons with real text and
 * the whole thing inherits the theme.
 *
 * A node whose heading the log carries is a button that opens the log there;
 * one the log does not show (cut, or never reached) is not.
 */

// Nodes share the width there is, between these; past the narrowest, the box scrolls.
const MIN_W = 136
const MAX_W = 200
const H = 56 // node height
const COL_GAP = 36
const ROW_GAP = 12
const HEAD = 22 // room above a column for its parallel stage's name

type Column = { stage: Stage; nodes: { stage: Stage; parent: Stage | null }[] }

export function StageGraph({ stages, onOpen }: { stages: Stage[]; onOpen?: (stage: Stage, parent: Stage | null) => (() => void) | null }) {
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setRoom(el.clientWidth)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  const W = Math.round(Math.min(MAX_W, Math.max(MIN_W, (room - (stages.length - 1) * COL_GAP) / Math.max(stages.length, 1))))
  const columns: Column[] = stages.map((stage) => ({
    stage,
    nodes: stage.branches.length ? stage.branches.map((b) => ({ stage: b, parent: stage })) : [{ stage, parent: null }],
  }))
  const head = columns.some((c) => c.stage.branches.length) ? HEAD : 0
  const rows = Math.max(1, ...columns.map((c) => c.nodes.length))
  const width = columns.length * W + (columns.length - 1) * COL_GAP
  const height = head + rows * H + (rows - 1) * ROW_GAP
  const x = (col: number) => col * (W + COL_GAP)
  const y = (row: number) => head + row * (H + ROW_GAP)
  const spine = y(0) + H / 2

  // Out of every node of a column to the spine between columns, and from there into every node of the next.
  const paths: string[] = []
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const bend = (x2 - x1) / 2
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
  }
  columns.forEach((column, i) => {
    const next = columns[i + 1]
    if (!next) return
    const mid = x(i) + W + COL_GAP / 2
    column.nodes.forEach((_, row) => paths.push(curve(x(i) + W, y(row) + H / 2, mid, spine)))
    next.nodes.forEach((_, row) => paths.push(curve(mid, spine, x(i + 1), y(row) + H / 2)))
  })

  return (
    // The box scrolls, never the page: a long pipeline is wider than a phone.
    <div ref={box} className="overflow-x-auto pb-2">
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0" aria-hidden>
          {paths.map((d, n) => (
            <path key={n} d={d} fill="none" className="stroke-muted-foreground/40" strokeWidth={1.5} />
          ))}
        </svg>
        {columns.map(
          (column, i) =>
            column.stage.branches.length > 0 && (
              <p
                key={`head-${i}`}
                className="absolute truncate text-xs font-medium text-muted-foreground"
                style={{ left: x(i), top: 0, width: W }}
                title={column.stage.name}
              >
                {column.stage.name} <span className="font-normal">· parallel</span>
              </p>
            ),
        )}
        <ol aria-label="Pipeline stages" className="contents">
          {columns.flatMap((column, i) =>
            column.nodes.map(({ stage, parent }, row) => (
              <li key={`${i}-${row}`} className="absolute" style={{ left: x(i), top: y(row), width: W, height: H }}>
                <Node stage={stage} parent={parent} open={onOpen?.(stage, parent) ?? null} />
              </li>
            )),
          )}
        </ol>
      </div>
    </div>
  )
}

function Node({ stage, parent, open }: { stage: Stage; parent: Stage | null; open: (() => void) | null }) {
  const { icon: Icon, label, dot } = RESULT[stage.result]
  const tone =
    stage.result === 'failure'
      ? 'border-destructive/40 text-destructive'
      : stage.result === 'success'
        ? 'text-success'
        : stage.result === 'unstable'
          ? 'border-warning/40 text-warning'
          : stage.result === 'running'
            ? 'text-info'
            : 'text-muted-foreground'
  const skipped = stage.result === 'not_built'
  const detail = skipped ? 'Did not run' : `${label}${stage.durationMs ? ` · ${duration(stage.durationMs)}` : ''}`
  const name = parent ? `${parent.name} › ${stage.name}` : stage.name
  const body = (
    <>
      <span className={`absolute inset-y-0 left-0 w-1 rounded-l-lg ${dot}`} aria-hidden />
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={`size-4 shrink-0 ${tone} ${stage.result === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
        <span className="truncate text-sm font-medium">{stage.name}</span>
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
    </>
  )
  const box = `relative block size-full rounded-lg border bg-card py-2 pr-2.5 pl-3.5 text-left shadow-xs ${skipped ? 'border-dashed opacity-70' : ''} ${tone.split(' ')[0]?.startsWith('border-') ? tone.split(' ')[0] : ''}`
  return open ? (
    <button
      type="button"
      onClick={open}
      className={`${box} transition-colors hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none`}
      aria-label={`${name}: ${detail}. Show it in the log`}
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
