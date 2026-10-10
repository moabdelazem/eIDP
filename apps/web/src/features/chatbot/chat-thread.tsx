import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  ClipboardCheck,
  Copy,
  FileQuestion,
  GitBranch,
  ListChecks,
  RotateCcw,
  Search,
  ShieldQuestion,
  Square,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import type { PageContext } from './api.ts'

// react-markdown and its parser load with the first answer, not with every page the dock sits on.
const Markdown = lazy(() => import('./markdown.tsx').then((m) => ({ default: m.Markdown })))
import type { Chat, Shown } from './use-chat.ts'

/**
 * A conversation on screen — the same in the full page and in the dock:
 * questions, answers as they stream with what was looked up for each, the
 * actions on an answer (copy, write again, useful or not), and where to type.
 * An empty conversation offers questions to start from, chosen for the
 * person's permissions and the page they are on.
 */
export function ChatThread({
  chat,
  greeting,
  page,
  compact = false,
  onNavigate,
}: {
  chat: Chat
  greeting: string
  page: PageContext | null
  compact?: boolean
  /** A link in an answer was followed — the dock closes. */
  onNavigate?: () => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const last = chat.messages.at(-1)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [chat.messages.length, last?.content, last?.steps.length])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`min-h-0 flex-1 space-y-6 ${compact ? 'overflow-y-auto px-4 py-4' : ''}`} aria-live="polite">
        {chat.loadError ? (
          <p className="text-sm text-destructive">{chat.loadError}</p>
        ) : chat.loading ? (
          <p className="text-sm text-muted-foreground">Opening the conversation…</p>
        ) : chat.messages.length === 0 ? (
          <Welcome greeting={greeting} page={page} compact={compact} onPick={(q) => void chat.send(q)} />
        ) : (
          chat.messages.map((m, n) => (
            <Bubble
              key={m.id}
              message={m}
              last={n === chat.messages.length - 1}
              busy={chat.busy}
              onRegenerate={() => void chat.regenerate()}
              onFeedback={(value) => void chat.feedback(m, value)}
              onNavigate={onNavigate}
            />
          ))
        )}
        <div ref={end} />
      </div>
      <Composer chat={chat} compact={compact} />
    </div>
  )
}

type Suggestion = { text: string; icon: LucideIcon }

/** Questions to start from: about the page they are on first, then what they may ask about at all. */
function suggestionsFor(page: PageContext | null, can: (p: Parameters<ReturnType<typeof useProfile>['can']>[0]) => boolean): Suggestion[] {
  const path = page?.path ?? ''
  const here: Suggestion[] = []
  if (/^\/(jenkins|pipelines)\/build\?/.test(path)) here.push({ text: 'Why did this build fail?', icon: TriangleAlert }, { text: 'Which stage took the longest in this build?', icon: Workflow })
  else if (path.startsWith('/projects/')) here.push({ text: 'Summarize this application’s configuration in prd', icon: FileQuestion }, { text: 'Who owns this application?', icon: ShieldQuestion })
  else if (path.startsWith('/digest')) here.push({ text: 'Summarize my team’s week', icon: ListChecks })
  else if (/^\/requests\/[0-9a-f-]{36}/.test(path)) here.push({ text: 'Where is this request up to?', icon: ClipboardCheck })
  const general: Suggestion[] = [
    ...(can('pipelines.view') ? [{ text: 'Which of my pipelines are broken?', icon: Workflow }] : []),
    ...(can('requests.decide') ? [{ text: 'Anything waiting for my approval?', icon: ListChecks }] : []),
    { text: 'Request a new repository for my team', icon: GitBranch },
    { text: 'What can I do in the portal?', icon: ShieldQuestion },
    { text: 'Which Spring apps do we run on prd?', icon: Search },
    { text: 'How do I undo my last git commit?', icon: GitBranch },
  ]
  return [...here, ...general].slice(0, 6)
}

function Welcome({ greeting, page, compact, onPick }: { greeting: string; page: PageContext | null; compact: boolean; onPick: (question: string) => void }) {
  const { can } = useProfile()
  const suggestions = suggestionsFor(page, can)
  return (
    <div className={compact ? 'pt-2' : 'pt-6'}>
      <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-[var(--chart-1)]" aria-hidden>
        <Bot className="size-5" />
      </span>
      <p className={`mt-3 font-semibold tracking-tight ${compact ? 'text-base' : 'text-xl'}`}>{greeting}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Ask about our systems, owners, configuration, requests and pipelines — or anything engineering. It looks things up as far as you may see, and
        never changes anything.
      </p>
      <div className={`mt-5 grid gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
        {suggestions.map(({ text, icon: Icon }, n) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="reveal flex items-start gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left text-sm shadow-xs transition-colors hover:bg-secondary"
            style={{ animationDelay: `${n * 40}ms` }}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Bubble({
  message: m,
  last,
  busy,
  onRegenerate,
  onFeedback,
  onNavigate,
}: {
  message: Shown
  last: boolean
  busy: boolean
  onRegenerate: () => void
  onFeedback: (value: 'up' | 'down' | null) => void
  onNavigate?: () => void
}) {
  if (m.role === 'user') {
    return (
      <div className="reveal ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm whitespace-pre-wrap text-secondary-foreground">
        {m.content}
      </div>
    )
  }
  const settled = !m.streaming && !m.error && !m.stopped && m.id > 0
  return (
    <div className="group/answer flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-card" aria-hidden>
        <Bot className="size-3.5 text-[var(--chart-1)]" />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <Steps message={m} />
        {m.content ? (
          <Suspense fallback={<p className="text-sm whitespace-pre-wrap">{m.content}</p>}>
            <Markdown text={m.content} onNavigate={onNavigate} />
          </Suspense>
        ) : m.streaming ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="chat-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
            {m.steps.length ? 'Reading what it found…' : 'Thinking…'}
          </p>
        ) : null}
        {m.error && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
            <TriangleAlert className="size-4 shrink-0" /> {m.error}
            {last && (
              <Button size="sm" variant="outline" onClick={onRegenerate} disabled={busy}>
                <RotateCcw /> Try again
              </Button>
            )}
          </div>
        )}
        {m.stopped && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Stopped — this answer was not kept.
            {last && (
              <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={onRegenerate} disabled={busy}>
                Answer again
              </button>
            )}
          </p>
        )}
        {settled && <Actions message={m} last={last} busy={busy} onRegenerate={onRegenerate} onFeedback={onFeedback} />}
      </div>
    </div>
  )
}

/** What it looked up: listed while it works, folded into one line once the answer is written. */
function Steps({ message: m }: { message: Shown }) {
  if (m.steps.length === 0) return null
  const working = m.streaming && !m.content
  const list = (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {m.steps.map((step, n) => (
        <li key={n} className="reveal flex items-center gap-1.5">
          {working && n === m.steps.length - 1 ? <Search className="size-3.5 animate-pulse motion-reduce:animate-none" /> : <Check className="size-3.5 text-success" />}
          {step}
        </li>
      ))}
    </ul>
  )
  if (working) return <div aria-label="What it is looking up">{list}</div>
  return (
    <details className="group/steps">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-open/steps:rotate-90 motion-reduce:transition-none" aria-hidden />
        Looked up {m.steps.length === 1 ? 'one thing' : `${m.steps.length} things`}
      </summary>
      <div className="mt-1.5 pl-5">{list}</div>
    </details>
  )
}

function Actions({
  message: m,
  last,
  busy,
  onRegenerate,
  onFeedback,
}: {
  message: Shown
  last: boolean
  busy: boolean
  onRegenerate: () => void
  onFeedback: (value: 'up' | 'down' | null) => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
      <Action label={copied ? 'Copied' : 'Copy the answer'} onClick={() => void navigator.clipboard.writeText(m.content).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
        {copied ? <Check /> : <Copy />}
      </Action>
      {last && (
        <Action label="Write this answer again" onClick={onRegenerate} disabled={busy}>
          <RotateCcw />
        </Action>
      )}
      <Action label="Useful" pressed={m.feedback === 'up'} onClick={() => onFeedback(m.feedback === 'up' ? null : 'up')}>
        <ThumbsUp className={m.feedback === 'up' ? 'fill-current text-success' : ''} />
      </Action>
      <Action label="Not useful" pressed={m.feedback === 'down'} onClick={() => onFeedback(m.feedback === 'down' ? null : 'down')}>
        <ThumbsDown className={m.feedback === 'down' ? 'fill-current' : ''} />
      </Action>
      <span className="ml-1">
        {m.model} · {since(m.createdAt)} · can be wrong — check what matters
      </span>
    </div>
  )
}

function Action({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:bg-secondary hover:text-foreground aria-pressed:bg-secondary aria-pressed:text-foreground [&_svg]:size-3.5"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={pressed}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Composer({ chat, compact }: { chat: Chat; compact: boolean }) {
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  // Grows with what is typed, up to a few lines, then scrolls.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`
  }, [draft])

  const send = () => {
    if (chat.busy || !draft.trim()) return
    void chat.send(draft)
    setDraft('')
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    send()
  }
  // Enter sends; Shift+Enter is a new line — and neither while an IME is composing.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }
  return (
    <form onSubmit={submit} className={compact ? 'border-t bg-background p-3' : 'sticky bottom-0 mt-6 bg-background pt-2 pb-4'}>
      <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:ring-[3px] focus-within:ring-ring/40">
        <Textarea
          ref={box}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about an application, a build, a request — or anything engineering"
          aria-label="Your question"
          rows={1}
          maxLength={8000}
          disabled={Boolean(chat.loadError)}
          data-chatbot-input
          className="max-h-48 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {chat.busy ? (
          <Button type="button" size="icon" variant="outline" onClick={chat.stop} aria-label="Stop the answer">
            <Square />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={!draft.trim() || Boolean(chat.loadError)} aria-label="Ask">
            <ArrowUp />
          </Button>
        )}
      </div>
      {!compact && <p className="mt-1.5 px-2 text-xs text-muted-foreground">Enter to ask, Shift+Enter for a new line. Ctrl/⌘ J opens it on any page.</p>}
    </form>
  )
}
