import type { CSSProperties } from 'react'

/**
 * ANSI colour codes in a console log, as Jenkins' AnsiColor plugin shows them:
 * each line becomes its text and the styled runs within it. Pure; the line
 * text keeps no escape codes, so find, error marking and copying see what a
 * person reads.
 *
 * The style carries from one line to the next until something resets it — a
 * tool that turns red, prints three lines and resets has three red lines, as
 * in a terminal. Only SGR (`ESC[…m`) is drawn; cursor movement, erasing and
 * the like are dropped. A carriage return without a newline is a progress
 * line redrawing itself: what was written after the last one is what the
 * terminal ended up showing.
 */

/** The 16 base colours are theme tokens (`--ansi-0` … `--ansi-15` in index.css), so they read in light and dark; beyond them, the xterm palette. */
export type Colour = { index: number } | { rgb: [number, number, number] }

export type Style = {
  fg: Colour | null
  bg: Colour | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

export type Segment = { text: string; style: Style }

export const PLAIN: Style = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false })

// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g

const isPlain = (s: Style) => !s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.inverse

/** What a terminal shows of a line written with carriage returns: the last frame, over what was there. */
export function lastFrame(line: string): string {
  const raw = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!raw.includes('\r')) return raw
  // Each frame overwrites from column 0; a shorter frame leaves the end of a longer one, as a terminal does.
  let shown = ''
  for (const frame of raw.split('\r')) shown = frame + shown.slice(visibleLength(frame))
  return shown
}

const visibleLength = (text: string) => text.replace(ESCAPE, '').length

/** Applies one SGR sequence's parameters to a style. */
function apply(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)))
  let s = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!
    if (c === 0) s = { ...PLAIN }
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 7) s.inverse = true
    else if (c === 22) s.bold = s.dim = false
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c === 27) s.inverse = false
    else if (c >= 30 && c <= 37) s.fg = { index: c - 30 }
    else if (c >= 90 && c <= 97) s.fg = { index: c - 90 + 8 }
    else if (c === 39) s.fg = null
    else if (c >= 40 && c <= 47) s.bg = { index: c - 40 }
    else if (c >= 100 && c <= 107) s.bg = { index: c - 100 + 8 }
    else if (c === 49) s.bg = null
    else if (c === 38 || c === 48) {
      // 38;5;n — the 256-colour palette; 38;2;r;g;b — true colour.
      let colour: Colour | null = null
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        colour = palette(codes[i + 2]!)
        i += 2
      } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
        colour = { rgb: [clamp(codes[i + 2]!), clamp(codes[i + 3]!), clamp(codes[i + 4]!)] }
        i += 4
      } else break
      if (c === 38) s.fg = colour
      else s.bg = colour
    }
    // Anything else (blink, strike-through, fonts…) is not drawn.
  }
  return s
}

const clamp = (n: number) => Math.max(0, Math.min(255, Number.isFinite(n) ? n : 0))

/** A 256-colour index: the first 16 are the themed base colours; then the 6×6×6 cube and the greys. */
export function palette(n: number): Colour {
  const i = clamp(n)
  if (i < 16) return { index: i }
  if (i >= 232) {
    const v = 8 + (i - 232) * 10
    return { rgb: [v, v, v] }
  }
  const k = i - 16
  const step = (x: number) => (x === 0 ? 0 : 55 + x * 40)
  return { rgb: [step(Math.floor(k / 36)), step(Math.floor(k / 6) % 6), step(k % 6)] }
}

/**
 * Each line's text without escape codes, its styled runs (null when the line
 * has no styling at all — the common case, drawn as before), and whether the
 * log had any colour.
 */
export function readAnsi(lines: string[]): { text: string; segments: Segment[] | null }[] {
  let style: Style = PLAIN
  return lines.map((line) => {
    const raw = lastFrame(line)
    if (!raw.includes('\x1b')) {
      return { text: raw, segments: isPlain(style) || raw === '' ? null : [{ text: raw, style }] }
    }
    const segments: Segment[] = []
    let from = 0
    for (const m of raw.matchAll(ESCAPE)) {
      if (m.index > from) segments.push({ text: raw.slice(from, m.index), style })
      if (m[2] === 'm') style = apply(style, m[1]!)
      from = m.index + m[0].length
    }
    if (from < raw.length) segments.push({ text: raw.slice(from), style })
    const text = segments.map((s) => s.text).join('')
    // Codes that only reset, around plain text, are no styling.
    return { text, segments: segments.some((s) => !isPlain(s.style)) ? merge(segments) : null }
  })
}

/** Neighbouring runs of the same style as one. */
function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segments) {
    const prev = out.at(-1)
    if (prev && prev.style === s.style) prev.text += s.text
    else out.push({ ...s })
  }
  return out
}

/** A style as inline CSS: themed tokens for the base colours, the given colour otherwise. */
export function css(style: Style): CSSProperties | undefined {
  if (isPlain(style)) return undefined
  const colour = (c: Colour | null) => (c ? ('index' in c ? `var(--ansi-${c.index})` : `rgb(${c.rgb.join(' ')})`) : undefined)
  // Bold brightens the base colours, as most terminals (and Jenkins) do.
  const fgColour = style.fg && 'index' in style.fg && style.bold && style.fg.index < 8 ? { index: style.fg.index + 8 } : style.fg
  let fg = colour(fgColour)
  let bg = colour(style.bg)
  if (style.inverse) [fg, bg] = [bg ?? 'var(--card)', fg ?? 'var(--foreground)']
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: style.bold ? 600 : undefined,
    opacity: style.dim ? 0.7 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: style.underline ? 'underline' : undefined,
  }
}
