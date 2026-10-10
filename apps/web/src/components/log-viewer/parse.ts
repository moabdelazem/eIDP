/**
 * Reading a console log into lines that know what they are. Pure, so the
 * viewer only draws — and so the rules sit in one place: `ERROR` here and in
 * the API's `modules/jenkins/explainer.ts` must stay the same regex, or the model is
 * shown different "errors" from the ones the page marks.
 */

export type Kind = 'error' | 'warning' | 'stage' | 'step' | 'command' | 'done' | 'plain'
/** `time` is the `timestamps {}` prefix, shown in its own column and taken off the text. */
export type Line = { n: number; text: string; kind: Kind; stage: string | null; time: string | null }

// eslint-disable-next-line no-control-regex
export const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
export const STAGE = /^\[Pipeline\] \{ \((.+)\)$/
// Case-sensitive on purpose: "ERROR" is a log level, "error" is often prose
// ("0 errors"). Counts only count when they are not zero.
export const ERROR = /(^|[\s[])(ERROR|FATAL|SEVERE)\b|\bBUILD FAILURE\b|Finished: FAILURE|\b(Failures|Errors): [1-9]|exit code [1-9]|Exception\b|^\s+at [\w$.]+\(/
const WARNING = /(^|[\s[])(WARN|WARNING)\b|Finished: UNSTABLE/
// Pipeline's `timestamps {}` writes `[2026-10-04T09:12:03.120Z] ` before each line; older setups `[09:12:03] `.
const TIME = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|\d{2}:\d{2}:\d{2})\] ?/
const clock = (stamp: string) =>
  stamp.includes('T') ? new Date(stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : stamp

export const stripAnsi = (log: string) => log.replace(ANSI, '')

export function parseLog(log: string, firstLine = 1): Line[] {
  let stage: string | null = null
  return stripAnsi(log)
    .replace(/\n$/, '')
    .split('\n')
    .map((raw, i) => {
      const stamp = TIME.exec(raw)
      const text = stamp ? raw.slice(stamp[0].length) : raw
      const opening = STAGE.exec(text)
      if (opening) stage = opening[1]!
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
      return { n: firstLine + i, text, kind, stage, time: stamp ? clock(stamp[1]!) : null }
    })
}

/** Every stage heading, with how many error lines fall under it — the stage menu. */
export function stagesOf(lines: Line[]): { name: string; line: number; errors: number }[] {
  const out: { name: string; line: number; errors: number }[] = []
  for (const l of lines) {
    if (l.kind === 'stage') out.push({ name: l.stage!, line: l.n, errors: 0 })
    else if (l.kind === 'error' && out.length) out.at(-1)!.errors++
  }
  return out
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
