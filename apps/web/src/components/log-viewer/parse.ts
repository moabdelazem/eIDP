/**
 * Reading a console log into lines that know what they are. Pure, so the
 * viewer only draws — and so the rules sit in one place: `ERROR` here and in
 * the API's `modules/jenkins/explainer.ts` must stay the same regex, or the model is
 * shown different "errors" from the ones the page marks.
 */

import { readAnsi, type Segment } from './ansi.ts'
import { highlight, type Token } from './highlight.ts'

export type Kind = 'error' | 'warning' | 'stage' | 'step' | 'command' | 'done' | 'plain'
/**
 * One line of the log. `text` is what it says, without escape codes — what
 * find, copy and the error rules read; `shown` is how it is drawn (a stage's
 * name, a command without its `+ `). `segments` are its ANSI colours, when the
 * tool printed any; otherwise `tokens` highlight `shown`. `time` is the
 * `timestamps {}` prefix, shown in its own column and taken off the text.
 * `within` is the heading line of every stage around it, outermost first.
 */
export type Line = {
  n: number
  text: string
  shown: string
  kind: Kind
  stage: string | null
  time: string | null
  segments: Segment[] | null
  tokens: Token[]
  within: number[]
  /** A heading's stage and the ones around it, outermost first: what the pinned heading reads. */
  path: string[] | null
}

/** A stage or parallel branch: its heading line, the line its block closes on, and what went wrong inside it (its own stages' included). */
export type StageNode = { name: string; line: number; end: number; depth: number; parent: number | null; errors: number; warnings: number }

const OPEN = '[Pipeline] {'
const CLOSE = '[Pipeline] }'
export const STAGE = /^\[Pipeline\] \{ \((.+)\)$/
// Case-sensitive on purpose: "ERROR" is a log level, "error" is often prose
// ("0 errors"). Counts only count when they are not zero.
export const ERROR = /(^|[\s[])(ERROR|FATAL|SEVERE)\b|\bBUILD FAILURE\b|Finished: FAILURE|\b(Failures|Errors): [1-9]|exit code [1-9]|Exception\b|^\s+at [\w$.]+\(/
const WARNING = /(^|[\s[])(WARN|WARNING)\b|Finished: UNSTABLE/
// Pipeline's `timestamps {}` writes `[2026-10-04T09:12:03.120Z] ` before each line; older setups `[09:12:03] `.
const TIME = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|\d{2}:\d{2}:\d{2})\] ?/
const clock = (stamp: string) =>
  stamp.includes('T') ? new Date(stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : stamp

/** The log as a person reads it: no escape codes, each progress line at its last frame. */
export const stripAnsi = (log: string) => readAnsi(log.split('\n')).map((l) => l.text).join('\n')

export function parseLog(log: string, firstLine = 1): Line[] {
  const raw = log.replace(/\r?\n$/, '').split('\n')
  const read = readAnsi(raw)
  // The open blocks: a stage's heading line, or null for an unnamed one (`node`, `withEnv`…).
  const open: { line: number | null; name: string | null }[] = []
  return read.map(({ text: full, segments: allSegments }, i) => {
    const n = firstLine + i
    const stamp = TIME.exec(full)
    const text = stamp ? full.slice(stamp[0].length) : full
    const segments = stamp && allSegments ? dropPrefix(allSegments, stamp[0].length) : allSegments
    const named = open.filter((b) => b.line !== null)
    const within = named.map((b) => b.line!)
    const opening = STAGE.exec(text)
    let path: string[] | null = null
    if (opening) {
      path = [...named.map((b) => b.name!), opening[1]!]
      open.push({ line: n, name: opening[1]! })
    } else if (text === OPEN) open.push({ line: null, name: null })
    else if (text === CLOSE) open.pop()
    const kind: Kind = opening
      ? 'stage'
      : ERROR.test(text)
        ? 'error'
        : WARNING.test(text)
          ? 'warning'
          : text.startsWith('[Pipeline]')
            ? 'step'
            : text.startsWith('+ ')
              ? 'command'
              : text === 'Finished: SUCCESS'
                ? 'done'
                : 'plain'
    const shown = kind === 'stage' ? opening![1]! : kind === 'command' ? text.slice(2) : text
    const lineSegments = kind === 'command' && segments ? dropPrefix(segments, 2) : kind === 'stage' ? null : segments
    return {
      n,
      text,
      shown,
      kind,
      // The stage a line is in is its innermost one; a heading is in its own.
      stage: opening ? opening[1]! : (named.at(-1)?.name ?? null),
      time: stamp ? clock(stamp[1]!) : null,
      segments: lineSegments,
      tokens: lineSegments ? [] : highlight(shown, kind === 'command' ? 'command' : kind === 'stage' ? 'stage' : kind === 'step' ? 'step' : 'other'),
      within,
      path,
    }
  })
}

/** Segments without the first `length` characters of the line (a timestamp, a `+ `). */
function dropPrefix(segments: Segment[], length: number): Segment[] | null {
  const out: Segment[] = []
  let skip = length
  for (const s of segments) {
    if (skip >= s.text.length) {
      skip -= s.text.length
      continue
    }
    out.push({ text: s.text.slice(skip), style: s.style })
    skip = 0
  }
  return out.length ? out : null
}

/**
 * The stages and parallel branches, in order, nested as `[Pipeline] {` and
 * `}` nest them — Jenkins' own structure, so a branch sits under its parallel
 * stage. A block the log does not close (a running build, a cut log) runs to
 * the last line. Errors and warnings count toward every stage around them.
 */
export function stageTree(lines: Line[]): StageNode[] {
  const nodes = new Map<number, StageNode>()
  const last = lines.at(-1)?.n ?? 0
  for (const l of lines) {
    if (l.kind === 'stage') {
      const parent = l.within.at(-1) ?? null
      nodes.set(l.n, { name: l.shown, line: l.n, end: last, depth: l.within.length, parent, errors: 0, warnings: 0 })
    }
    for (const h of l.within) {
      const node = nodes.get(h)
      if (!node) continue
      if (l.kind === 'error') node.errors++
      else if (l.kind === 'warning') node.warnings++
    }
  }
  // A block ends on the last line still inside it.
  for (const l of lines) for (const h of l.within) {
    const node = nodes.get(h)
    if (node) node.end = l.n
  }
  return [...nodes.values()]
}

/** Every stage heading, with how many error lines fall under it — the stage menu. */
export function stagesOf(lines: Line[]): StageNode[] {
  return stageTree(lines)
}

/** `#L12` or `#L12-L20` → the range; anything else → null. */
export function parseRange(hash: string): [number, number] | null {
  const m = /^#L(\d+)(?:-L?(\d+))?$/.exec(hash)
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  return [Math.min(a, b), Math.max(a, b)]
}

export const rangeHash = ([a, b]: [number, number]) => (a === b ? `#L${a}` : `#L${a}-L${b}`)
