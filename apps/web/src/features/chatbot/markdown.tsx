import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { Link } from 'react-router'
import { LogViewer } from '@/components/log-viewer/log-viewer.tsx'
import { highlightCode, languageOf } from '@/lib/highlight.ts'

const LOG_FENCES = new Set(['log', 'console'])

/**
 * The chatbot's answers are markdown, rendered by react-markdown with GitHub's
 * extensions (tables, task lists, strikethrough) into React elements — never
 * HTML: the text comes from a model that read our data, and nothing it writes
 * may become markup, so raw HTML in it is dropped (`skipHtml`) and URLs other
 * than http(s) and portal paths are not links.
 *
 * Portal paths (`/projects/…`, `/pipelines/build?…`) open in the portal;
 * http(s) links open in a new tab. CommonMark already reads `_x_` inside a
 * word as text, so names like `NBFS_LoanManagementSystem` stay names.
 *
 * Code blocks are highlighted by Shiki in the language their fence names,
 * loaded the first time it appears (`lib/highlight.ts`), with a copy button.
 * A half-written answer renders as it streams — an open fence is code until
 * it closes.
 */
export function Markdown({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith('/') && !href.startsWith('//')) {
        return (
          <Link to={href} onClick={onNavigate} className="font-medium text-primary underline-offset-2 hover:underline">
            {children}
          </Link>
        )
      }
      if (href && /^https?:\/\//i.test(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-primary underline-offset-2 hover:underline">
            {children}
          </a>
        )
      }
      return <>{children}</>
    },
    pre: ({ children }) => {
      const code = children as ReactElement<{ className?: string; children?: ReactNode }>
      const language = /language-([\w+-]+)/.exec(code?.props?.className ?? '')?.[1] ?? ''
      const text = String(code?.props?.children ?? '').replace(/\n$/, '')
      // A quoted log reads as the build page reads it: numbered, errors marked, findable, expandable.
      if (LOG_FENCES.has(language)) return <LogViewer log={text} compact title="Quoted log" fileName="chatbot-log" />
      return <CodeBlock language={language} code={text} />
    },
    code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
    table: ({ children }) => (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/50 text-xs text-muted-foreground">{children}</thead>,
    th: ({ children }) => <th className="border-b px-3 py-2 font-medium">{children}</th>,
    td: ({ children }) => <td className="border-b px-3 py-2 align-top">{children}</td>,
    ul: ({ children, className }) => <ul className={`space-y-1 pl-5 ${className?.includes('contains-task-list') ? 'list-none pl-1' : 'list-disc'}`}>{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
    h1: ({ children }) => <p className="text-base font-semibold">{children}</p>,
    h2: ({ children }) => <p className="text-base font-semibold">{children}</p>,
    h3: ({ children }) => <p className="font-semibold">{children}</p>,
    h4: ({ children }) => <p className="font-semibold">{children}</p>,
    blockquote: ({ children }) => <blockquote className="border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
    hr: () => <hr className="border-border" />,
    img: ({ alt }) => <span>{alt}</span>,
  }
  // break-words, not break-all: a long path or URL wraps rather than widening
  // the page, but an ordinary identifier is never split mid-word.
  return (
    <div className="min-w-0 space-y-3 text-sm leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const [html, setHtml] = useState<string | null>(null)
  const lang = languageOf(language)

  // Re-highlighted as an answer streams in, a moment after it stops changing.
  useEffect(() => {
    if (!lang) return
    let stale = false
    const timer = setTimeout(() => {
      highlightCode(code, lang)
        .then((out) => !stale && setHtml(out))
        .catch(() => !stale && setHtml(null))
    }, 120)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [code, lang])

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between border-b px-3 py-1 text-xs text-muted-foreground">
        <span className="font-mono">{language || 'code'}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
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
      {html ? (
        // Safe only because Shiki escapes every token of the code; keep it that way.
        <div className="chat-code overflow-x-auto p-3 font-mono text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
