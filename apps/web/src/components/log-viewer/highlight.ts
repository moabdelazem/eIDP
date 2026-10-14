/**
 * Syntax highlighting for the lines no tool coloured itself: what kind of
 * text each part of a line is, as a tree-sitter highlighter would say it —
 * a shell command's program, flags, strings and variables; a stack frame's
 * method and file; a JSON line's keys and values; a log line's level, paths,
 * versions, durations and hashes. Pure and line by line, so it costs nothing
 * a log of thousands of lines notices, and it never changes the text.
 *
 * A line with ANSI colours is the tool's own colouring and is left as it is.
 */

export type TokenType =
  | 'program'
  | 'flag'
  | 'variable'
  | 'operator'
  | 'string'
  | 'number'
  | 'constant'
  | 'key'
  | 'path'
  | 'url'
  | 'muted'
  | 'function'
  | 'error'
  | 'warning'
  | 'info'
  | 'success'

/** `start` and `end` are offsets into the line's text; tokens never overlap and come in order. */
export type Token = { start: number; end: number; type: TokenType }

/** Past this a line is drawn plain: a minified blob gains nothing from colour and costs a lot. */
const LONGEST = 2000

export function highlight(text: string, kind: 'command' | 'stage' | 'step' | 'other'): Token[] {
  if (!text || text.length > LONGEST || kind === 'stage' || kind === 'step') return []
  if (kind === 'command') return shell(text)
  const trimmed = text.trim()
  if (/^[{[]/.test(trimmed) && /[}\]],?$/.test(trimmed)) return json(text)
  if (STACK_FRAME.test(text)) return stackFrame(text)
  return generic(text)
}

// ---- shell: a `+ …` line, the command a step ran -------------------------

const SHELL = [
  [/'[^']*'?|"(?:[^"\\]|\\.)*"?/y, 'string'],
  [/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@#?$!*-]/y, 'variable'],
  [/\d?>>?(?:&\d)?|<|\|\||&&|\||;/y, 'operator'],
  [/--?[A-Za-z][\w-]*(?==)|--?[A-Za-z][\w.-]*/y, 'flag'],
] as const

function shell(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  // The first word, and the first after a pipe or `&&`, is the program run.
  let expectProgram = true
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++
      continue
    }
    let matched = false
    for (const [re, type] of SHELL) {
      re.lastIndex = i
      const m = re.exec(text)
      if (m && m[0]) {
        tokens.push({ start: i, end: i + m[0].length, type })
        i += m[0].length
        expectProgram = type === 'operator'
        matched = true
        break
      }
    }
    if (matched) continue
    const word = /[^\s'"|&;<>]+/y
    word.lastIndex = i
    const m = word.exec(text)!
    const value = m[0]
    if (expectProgram && !/^\w+=/.test(value)) tokens.push({ start: i, end: i + value.length, type: 'program' })
    else if (/^\w+=/.test(value)) {
      const eq = value.indexOf('=')
      tokens.push({ start: i, end: i + eq, type: 'variable' })
    } else if (value.includes('/') || /^\.\.?$/.test(value)) tokens.push({ start: i, end: i + value.length, type: 'path' })
    else if (/^\d+(\.\d+)*$/.test(value)) tokens.push({ start: i, end: i + value.length, type: 'number' })
    if (!/^\w+=/.test(value)) expectProgram = false
    i += value.length
  }
  return tokens
}

// ---- stack frames: Java, .NET, Python, Node --------------------------------

const STACK_FRAME = /^\s+at\s|^\s+File "[^"]+", line \d+|^\s+\.\.\. \d+ more$/

function stackFrame(text: string): Token[] {
  const tokens: Token[] = []
  // The package is lazy: the class and method are the last two names before the parenthesis.
  const java = /^(\s+)(at)\s+((?:[\w$]+\.)*?)([\w$<>]+(?:\.[\w$<>]+)?)(?=\(|\s*$)(\((.*?)(?::(\d+))?\))?/.exec(text)
  const dotnet = /^(\s+)(at)\s+(.+?)(\(.*?\))\s+in\s+(.+?):line\s+(\d+)\s*$/.exec(text)
  const python = /^(\s+)File "([^"]+)", line (\d+)(?:, in (.+))?$/.exec(text)
  if (dotnet) {
    let at = dotnet[1]!.length
    tokens.push({ start: at, end: at + 2, type: 'muted' })
    at = text.indexOf(dotnet[3]!, at + 2)
    tokens.push({ start: at, end: at + dotnet[3]!.length, type: 'function' })
    const file = text.lastIndexOf(dotnet[5]!)
    tokens.push({ start: file, end: file + dotnet[5]!.length, type: 'path' })
    const line = text.lastIndexOf(dotnet[6]!)
    tokens.push({ start: line, end: line + dotnet[6]!.length, type: 'number' })
  } else if (java) {
    let at = java[1]!.length
    tokens.push({ start: at, end: at + 2, type: 'muted' })
    at = text.indexOf(java[3]! + java[4]!, at + 2)
    // The package reads quieter than the class and method that failed.
    if (java[3]) tokens.push({ start: at, end: at + java[3].length, type: 'muted' })
    tokens.push({ start: at + java[3]!.length, end: at + java[3]!.length + java[4]!.length, type: 'function' })
    if (java[6]) {
      const file = text.indexOf(java[6], at + java[3]!.length + java[4]!.length)
      tokens.push({ start: file, end: file + java[6].length, type: 'path' })
      if (java[7]) {
        const line = text.indexOf(java[7], file + java[6].length)
        tokens.push({ start: line, end: line + java[7].length, type: 'number' })
      }
    }
  } else if (python) {
    const file = text.indexOf(python[2]!)
    tokens.push({ start: file, end: file + python[2]!.length, type: 'path' })
    const line = text.indexOf(python[3]!, file + python[2]!.length)
    tokens.push({ start: line, end: line + python[3]!.length, type: 'number' })
    if (python[4]) tokens.push({ start: text.length - python[4].length, end: text.length, type: 'function' })
  } else {
    tokens.push({ start: 0, end: text.length, type: 'muted' })
  }
  return tokens.filter((t) => t.start >= 0 && t.end > t.start).sort((a, b) => a.start - b.start)
}

// ---- a JSON line ------------------------------------------------------------

function json(text: string): Token[] {
  const tokens: Token[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g
  for (const m of text.matchAll(re)) {
    if (m[1]) tokens.push({ start: m.index, end: m.index + m[1].length, type: m[2] ? 'key' : 'string' })
    else tokens.push({ start: m.index, end: m.index + m[0].length, type: m[3] ? 'constant' : 'number' })
  }
  return tokens
}

// ---- any other line ---------------------------------------------------------

/** In order: the first that claims a stretch of the line keeps it. */
const GENERIC: [RegExp, TokenType][] = [
  // URLs first: a path or a number inside one is part of the link.
  [/https?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]]/g, 'url'],
  [/\[(?:ERROR|FATAL|SEVERE)\]|\b(?:ERROR|FATAL|SEVERE)\b|\bBUILD FAILURE\b|\bFAILED\b|\bFAILURE\b/g, 'error'],
  [/\[(?:WARN|WARNING)\]|\b(?:WARN|WARNING)\b|\bUNSTABLE\b/g, 'warning'],
  [/\[(?:INFO|NOTICE)\]|\bINFO\b/g, 'info'],
  [/\[(?:DEBUG|TRACE)\]|\b(?:DEBUG|TRACE)\b/g, 'muted'],
  [/\bBUILD SUCCESS(?:FUL)?\b|\bSUCCESS\b|\bPASSED\b/g, 'success'],
  [/"(?:[^"\\]|\\.)*"|'[^'\s][^']*'/g, 'string'],
  // key=value, the key only: `Tests run: 12` reads by its number.
  [/\b[A-Za-z_][\w.-]*(?==[^=\s])/g, 'key'],
  // A Java/.NET exception's class: the thing to search for.
  [/\b(?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\b|\b[A-Z]\w*(?:Exception|Error)\b(?=:|\s|$)/g, 'function'],
  [/(?:^|(?<=[\s='"(]))(?:[A-Za-z]:\\|\.{0,2}\/)[^\s'"():,]+/g, 'path'],
  [/\b[0-9a-f]{7,40}\b(?=[^\w]|$)/g, 'constant'],
  [/\bv?\d+\.\d+(?:\.\d+)+(?:[-+][\w.]+)?\b/g, 'number'],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|min|h|KB|MB|GB|kB|B|%)(?![\w])|\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, 'number'],
  // A bare number, not one joined to a name: the 01 of linux-01 is part of the name.
  [/(?<![\w.-])\d+(?:\.\d+)?(?![\w-])/g, 'number'],
]

function generic(text: string): Token[] {
  const tokens: Token[] = []
  const taken = (start: number, end: number) => tokens.some((t) => start < t.end && end > t.start)
  for (const [re, type] of GENERIC) {
    for (const m of text.matchAll(re)) {
      const start = m.index
      const end = start + m[0].length
      // A hash must mix letters and digits, or "deadbeef" words and plain numbers would pass.
      if (type === 'constant' && !(/\d/.test(m[0]) && /[a-f]/.test(m[0]))) continue
      if (end > start && !taken(start, end)) tokens.push({ start, end, type })
    }
  }
  return tokens.sort((a, b) => a.start - b.start)
}
