import { Fragment, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Link } from 'react-router'

/**
 * The assistant's answers are markdown. This renders the part of it a chat
 * answer uses — paragraphs, headings, lists, tables, code blocks, inline code,
 * bold, italics and links — as React elements, never as HTML: the text comes
 * from a model that read our data, and nothing it writes should become markup.
 *
 * Links to portal paths (`/projects/…`, `/jenkins/build?…`) open in the
 * portal; http(s) links open outside it; anything else stays text. It copes
 * with a half-written answer while it streams — an open code fence is code
 * until the fence closes.
 *
 * ponytail: hand-rolled for one screen's worth of markdown. If answers need
 * more (nested lists, footnotes), that is the time for a real parser.
 */
export function Markdown({ text }: { text: string }) {
  // break-words, not break-all: a long path or URL wraps rather than widening
  // the page, but an ordinary identifier is never split mid-word.
  return <div className="min-w-0 space-y-3 text-sm leading-relaxed break-words">{blocks(text)}</div>
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  const key = () => out.length

  while (i < lines.length) {
    const line = lines[i]!

    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!)
      i++ // the closing fence, if it has arrived
      out.push(<CodeBlock key={key()} language={fence[1] ?? ''} code={code.join('\n')} />)
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(
        <p key={key()} className={`font-semibold ${heading[1]!.length <= 2 ? 'text-base' : ''}`}>
          {inline(heading[2]!)}
        </p>,
      )
      i++
      continue
    }

    if (/^\s*\|/.test(line)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(lines[i++]!)
      out.push(<Table key={key()} rows={rows} />)
      continue
    }

    const bullet = /^\s*[-*•]\s+/
    const numbered = /^\s*\d+[.)]\s+/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const pattern = ordered ? numbered : bullet
      const items: string[] = []
      while (i < lines.length && (pattern.test(lines[i]!) || (items.length && /^\s{2,}\S/.test(lines[i]!)))) {
        const current = lines[i++]!
        if (pattern.test(current)) items.push(current.replace(pattern, ''))
        else items[items.length - 1] += ` ${current.trim()}`
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={key()} className={`space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </List>,
      )
      continue
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|#{1,4}\s|\||[-*•]\s|\d+[.)]\s)/.test(lines[i]!)) paragraph.push(lines[i++]!)
    if (paragraph.length === 0) paragraph.push(lines[i++]!)
    out.push(<p key={key()}>{inline(paragraph.join(' '))}</p>)
  }
  return out
}

// `_italic_` only between word boundaries: our names are full of underscores
// (NBFS_LoanManagementSystem), and those are not emphasis.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w]))/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index!
    if (at > last) out.push(text.slice(last, at))
    const [whole, code, bold, link, italic] = match
    if (code) out.push(<code key={at} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{code.slice(1, -1)}</code>)
    else if (bold) out.push(<strong key={at}>{inline(bold.slice(2, -2))}</strong>)
    else if (link) out.push(<Fragment key={at}>{renderLink(link)}</Fragment>)
    else if (italic) out.push(<em key={at}>{italic.slice(1, -1)}</em>)
    else out.push(whole)
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderLink(markdown: string): ReactNode {
  const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(markdown)!
  const className = 'font-medium text-foreground underline decoration-[var(--chart-1)] underline-offset-2 hover:decoration-2'
  // A portal path — the only links the tools hand the model.
  if (/^\/(?!\/)/.test(href!)) {
    return (
      <Link to={href!} className={className}>
        {label}
      </Link>
    )
  }
  if (/^https?:\/\//i.test(href!)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
        {label}
      </a>
    )
  }
  return label
}

function Table({ rows }: { rows: string[] }) {
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
  const [head, ...rest] = rows
  const body = rest.filter((row) => !/^\s*\|?\s*:?-{2,}/.test(row))
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50">
          <tr>
            {cells(head!).map((cell, n) => (
              <th key={n} className="px-3 py-2 font-medium">
                {inline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="border-t">
              {cells(row).map((cell, n) => (
                <td key={n} className="px-3 py-2 align-top">
                  {inline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between border-b px-3 py-1 text-xs text-muted-foreground">
        <span className="font-mono">{language || 'code'}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          onClick={() =>
            navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}
