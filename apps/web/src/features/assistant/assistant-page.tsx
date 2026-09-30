import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowUp, Check, History, MessageSquarePlus, Search, Sparkles, Square, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { assistantApi, type AssistantEvent, type Conversation, type Message } from './api.ts'
import { Markdown } from './markdown.tsx'

/** A message on screen: stored, or the answer still being written. */
type Shown = Message & { streaming?: boolean; error?: string; stopped?: boolean }

const SUGGESTIONS_ALL = [
  'Which Spring apps do we run on prd?',
  'Who owns AgriLand?',
  'Where are my requests?',
  'How do I request a new repository?',
  'How do I undo my last git commit?',
]
const SUGGESTIONS_JENKINS = ['What is failing in Jenkins right now?', 'How did Jenkins do over the last 7 days?']

/**
 * The assistant: ask about our systems, applications, owners, requests and
 * builds, or about engineering in general. It looks things up with read-only
 * tools, as far as the person asking may see, and shows what it looked up
 * beside each answer — so an answer can be checked, not just believed.
 *
 * Conversations are kept and listed beside the chat (in a sheet on a phone);
 * each has its own URL, readable only by its owner.
 */
export function AssistantPage() {
  const { conversationId = null } = useParams()
  const navigate = useNavigate()
  const home = useResource(() => assistantApi.home(), [])
  const [messages, setMessages] = useState<Shown[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [forgetting, setForgetting] = useState<Conversation | null>(null)
  const stop = useRef<AbortController | null>(null)
  // A conversation this page just started: its URL changes, its messages are already here.
  const created = useRef<string | null>(null)
  const { can } = useProfile()

  const current = home.data?.conversations.find((c) => c.id === conversationId) ?? null
  usePageTitle(current ? `${current.title} — Assistant` : 'Assistant')

  // Load a conversation when the URL names one this page did not just create.
  useEffect(() => {
    if (conversationId === loadedFor) return
    if (conversationId && conversationId === created.current) {
      setLoadedFor(conversationId)
      return
    }
    stop.current?.abort()
    setLoadError(null)
    if (!conversationId) {
      setMessages([])
      setLoadedFor(null)
      return
    }
    let stale = false
    assistantApi
      .conversation(conversationId)
      .then(({ messages }) => {
        if (stale) return
        setMessages(messages)
        setLoadedFor(conversationId)
      })
      .catch((err: unknown) => !stale && setLoadError(err instanceof ApiError ? err.message : 'Could not open that conversation.'))
    return () => {
      stale = true
    }
  }, [conversationId, loadedFor])

  // Stop a running answer when leaving the page.
  useEffect(() => () => stop.current?.abort(), [])

  const bottom = useRef<HTMLDivElement>(null)
  const last = messages.at(-1)
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, last?.content, last?.steps.length])

  async function send(text: string) {
    const question = text.trim()
    if (!question || busy) return
    setDraft('')
    setBusy(true)
    const now = new Date().toISOString()
    setMessages((m) => [
      ...m,
      { id: -Date.now(), role: 'user', content: question, steps: [], model: null, createdAt: now },
      { id: -Date.now() - 1, role: 'assistant', content: '', steps: [], model: null, createdAt: now, streaming: true },
    ])
    const update = (change: (pending: Shown) => Shown) =>
      setMessages((m) => [...m.slice(0, -1), change(m.at(-1)!)])

    const controller = new AbortController()
    stop.current = controller
    try {
      await assistantApi.ask(
        question,
        conversationId,
        (event: AssistantEvent) => {
          switch (event.type) {
            case 'conversation':
              if (event.conversation.id !== conversationId) {
                created.current = event.conversation.id
                navigate(`/assistant/${event.conversation.id}`, { replace: !conversationId })
              }
              break
            case 'step':
              update((p) => ({ ...p, steps: [...p.steps, event.label] }))
              break
            case 'delta':
              update((p) => ({ ...p, content: p.content + event.text }))
              break
            case 'reset':
              update((p) => ({ ...p, content: '' }))
              break
            case 'done':
              update(() => event.message)
              break
            case 'error':
              update((p) => ({ ...p, streaming: false, error: event.message }))
              break
          }
        },
        controller.signal,
      )
      if (controller.signal.aborted) update((p) => ({ ...p, streaming: false, stopped: true }))
    } catch (err) {
      update((p) => ({ ...p, streaming: false, error: err instanceof ApiError ? err.message : 'The assistant could not answer. Try again.' }))
    } finally {
      stop.current = null
      setBusy(false)
      home.reload()
    }
  }

  async function forget(conversation: Conversation): Promise<boolean> {
    try {
      await assistantApi.remove(conversation.id)
      toast.success('Conversation deleted')
      if (conversation.id === conversationId) navigate('/assistant')
      home.reload()
      return true
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete it.')
      return false
    }
  }

  if (home.error && !home.data) return <p className={`${PAGE} text-sm text-destructive`}>{home.error}</p>
  if (!home.data) {
    return (
      <Loading label="Loading the assistant…" className={PAGE}>
        <RowsSkeleton rows={4} />
      </Loading>
    )
  }
  if (!home.data.ai.configured) {
    return (
      <div className={PAGE}>
        <EmptyState title="The assistant is not set up" icon={Sparkles}>
          It needs the portal’s Ollama, and OLLAMA_URL is not set on the API. Ask DevOps to configure it.
        </EmptyState>
      </div>
    )
  }

  const model = home.data.ai.model ?? 'the model'
  const conversations = home.data.conversations
  const suggestions = [...(can('jenkins.view') ? SUGGESTIONS_JENKINS : []), ...SUGGESTIONS_ALL].slice(0, 6)
  const list = <ConversationList conversations={conversations} current={conversationId} onForget={setForgetting} />

  return (
    <div className={`${PAGE} grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]`}>
      <aside className="hidden lg:block">
        <div className="sticky top-6">{list}</div>
      </aside>

      <section className="flex min-h-[calc(100svh-8rem)] min-w-0 flex-col">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              <Sparkles className="size-5 text-[var(--chart-1)]" aria-hidden />
              Assistant
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask about our systems, applications, owners, requests{can('jenkins.view') ? ' and builds' : ''} — or anything engineering.{' '}
              {model} on our own Ollama answers, and it can be wrong.
            </p>
          </div>
          <div className="flex gap-2">
            <Sheet>
              <SheetTrigger asChild>
                <Button size="sm" variant="outline" className="lg:hidden">
                  <History /> History
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 p-4">
                <SheetHeader className="p-0">
                  <SheetTitle>Conversations</SheetTitle>
                </SheetHeader>
                {list}
              </SheetContent>
            </Sheet>
            {conversationId && (
              <Button asChild size="sm" variant="outline" className="lg:hidden">
                <Link to="/assistant">
                  <MessageSquarePlus /> New chat
                </Link>
              </Button>
            )}
          </div>
        </header>

        <div className="mt-6 flex-1 space-y-6" aria-live="polite">
          {loadError ? (
            <EmptyState title="This conversation can’t be opened">{loadError}</EmptyState>
          ) : loadedFor !== conversationId ? (
            <Loading label="Opening the conversation…">
              <RowsSkeleton rows={3} bordered={false} />
            </Loading>
          ) : messages.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6">
              <p className="text-sm text-muted-foreground">Try one of these, or ask your own:</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <Button key={s} variant="outline" size="sm" className="h-auto py-1.5 text-left whitespace-normal" onClick={() => void send(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
          <div ref={bottom} />
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          busy={busy}
          onSend={() => void send(draft)}
          onStop={() => stop.current?.abort()}
          disabled={Boolean(loadError)}
        />
      </section>

      <ConfirmDialog
        open={forgetting !== null}
        onOpenChange={(open) => !open && setForgetting(null)}
        title="Delete this conversation?"
        confirm="Delete"
        destructive
        onConfirm={() => forget(forgetting!)}
      >
        <p className="text-foreground">{forgetting?.title}</p>
        <p>Its questions and answers are gone for good.</p>
      </ConfirmDialog>
    </div>
  )
}

function ConversationList({
  conversations,
  current,
  onForget,
}: {
  conversations: Conversation[]
  current: string | null
  onForget: (conversation: Conversation) => void
}) {
  return (
    <nav aria-label="Conversations" className="space-y-3">
      <Button asChild variant="outline" size="sm" className="w-full justify-start">
        <Link to="/assistant">
          <MessageSquarePlus /> New chat
        </Link>
      </Button>
      {conversations.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">Your conversations will be listed here. Only you can see them.</p>
      ) : (
        <ul className="space-y-0.5">
          {conversations.map((c) => (
            <li key={c.id} className="group flex items-center gap-1">
              <Link
                to={`/assistant/${c.id}`}
                aria-current={c.id === current ? 'page' : undefined}
                className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${c.id === current ? 'bg-secondary font-medium text-secondary-foreground' : ''}`}
              >
                <span className="block truncate">{c.title}</span>
                <span className="block text-xs text-muted-foreground">{since(c.updatedAt)}</span>
              </Link>
              <button
                type="button"
                onClick={() => onForget(c)}
                className="rounded p-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                aria-label={`Delete “${c.title}”`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

function Bubble({ message: m }: { message: Shown }) {
  if (m.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm whitespace-pre-wrap text-secondary-foreground">
        {m.content}
      </div>
    )
  }
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-card" aria-hidden>
        <Sparkles className="size-3.5 text-[var(--chart-1)]" />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        {m.steps.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground" aria-label="What it looked up">
            {m.steps.map((step, n) => (
              <li key={n} className="flex items-center gap-1.5">
                {m.streaming && n === m.steps.length - 1 && !m.content ? (
                  <Search className="size-3.5 animate-pulse motion-reduce:animate-none" />
                ) : (
                  <Check className="size-3.5 text-success" />
                )}
                {step}
              </li>
            ))}
          </ul>
        )}
        {m.content ? (
          <Markdown text={m.content} />
        ) : m.streaming ? (
          <p className="text-sm text-muted-foreground">{m.steps.length ? 'Reading what it found…' : 'Thinking…'}</p>
        ) : null}
        {m.error && (
          <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {m.error}
          </p>
        )}
        {m.stopped && <p className="text-xs text-muted-foreground">Stopped. This answer was not kept.</p>}
        {!m.streaming && !m.error && !m.stopped && m.model && (
          <p className="text-xs text-muted-foreground">{m.model} · {since(m.createdAt)} · can be wrong — check what matters.</p>
        )}
      </div>
    </div>
  )
}

function Composer({
  value,
  onChange,
  busy,
  onSend,
  onStop,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  busy: boolean
  onSend: () => void
  onStop: () => void
  disabled: boolean
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy) onSend()
  }
  // Enter sends; Shift+Enter is a new line — and neither while an IME is composing.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!busy) onSend()
    }
  }
  return (
    <form onSubmit={submit} className="sticky bottom-0 mt-6 bg-background pt-2 pb-4">
      <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-[3px] focus-within:ring-ring/40">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about an application, an owner, a request, a build — or anything engineering"
          aria-label="Your question"
          rows={1}
          maxLength={8000}
          disabled={disabled}
          className="max-h-48 min-h-10 resize-none border-0 shadow-none focus-visible:ring-0"
        />
        {busy ? (
          <Button type="button" size="icon" variant="outline" onClick={onStop} aria-label="Stop the answer">
            <Square />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={!value.trim() || disabled} aria-label="Ask">
            <ArrowUp />
          </Button>
        )}
      </div>
      <p className="mt-1.5 px-2 text-xs text-muted-foreground">Enter to ask, Shift+Enter for a new line. It can only look things up — it never changes anything.</p>
    </form>
  )
}
