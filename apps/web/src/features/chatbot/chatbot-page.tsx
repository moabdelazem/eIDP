import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Bot, History, MessageSquarePlus, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useSession } from '@/features/auth/session-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { chatbotApi, type Conversation } from './api.ts'
import { ChatThread } from './chat-thread.tsx'
import { useChat } from './use-chat.ts'

/**
 * The chatbot, full page: conversations listed beside the chat (in a sheet on
 * a phone), searchable, grouped by when they were last used, each renamable
 * and deletable, each with its own URL readable only by its owner. The same
 * chat is in the dock on every other page (`chatbot-dock.tsx`).
 */
export function ChatbotPage() {
  const { conversationId = null } = useParams()
  const navigate = useNavigate()
  const { session } = useSession()
  const home = useResource(['chatbot', 'home'], () => chatbotApi.home())
  const [forgetting, setForgetting] = useState<Conversation | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})

  const chat = useChat({
    conversationId,
    onConversation: useCallback(
      (c: Conversation, created: boolean) => {
        if (created) navigate(`/chatbot/${c.id}`, { replace: !conversationId })
      },
      [navigate, conversationId],
    ),
    onTitle: useCallback((c: Conversation) => setTitles((t) => ({ ...t, [c.id]: c.title })), []),
    onSettled: home.reload,
  })

  const conversations = useMemo(
    () => (home.data?.conversations ?? []).map((c) => (titles[c.id] ? { ...c, title: titles[c.id]! } : c)),
    [home.data, titles],
  )
  const current = conversations.find((c) => c.id === conversationId) ?? null
  usePageTitle(current ? `${current.title} — Chatbot` : 'Chatbot')

  async function forget(conversation: Conversation): Promise<boolean> {
    try {
      await chatbotApi.remove(conversation.id)
      toast.success('Conversation deleted')
      if (conversation.id === conversationId) navigate('/chatbot')
      home.reload()
      return true
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete it.')
      return false
    }
  }

  async function rename(conversation: Conversation, title: string) {
    try {
      const renamed = await chatbotApi.rename(conversation.id, title)
      setTitles((t) => ({ ...t, [renamed.id]: renamed.title }))
      home.reload()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not rename it.')
    }
  }

  if (home.error && !home.data) return <p className={`${PAGE} text-sm text-destructive`}>{home.error}</p>
  if (!home.data) {
    return (
      <Loading label="Loading the chatbot…" className={PAGE}>
        <RowsSkeleton rows={4} />
      </Loading>
    )
  }
  if (!home.data.ai.configured) {
    return (
      <div className={PAGE}>
        <EmptyState title="The chatbot is not set up" icon={Bot}>
          It needs the portal’s Ollama, and OLLAMA_URL is not set on the API. Ask DevOps to configure it.
        </EmptyState>
      </div>
    )
  }

  const list = <ConversationList conversations={conversations} current={conversationId} onForget={setForgetting} onRename={rename} />
  const first = session?.name.split(/\s+/)[0]

  return (
    <div className={`${PAGE} grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]`}>
      <aside className="hidden lg:block">
        <div className="sticky top-6 max-h-[calc(100svh-8rem)] overflow-y-auto pr-1">{list}</div>
      </aside>

      <section className="flex min-h-[calc(100svh-8rem)] min-w-0 flex-col">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              <Bot className="size-5 text-[var(--chart-1)]" aria-hidden />
              <span className="truncate">{current?.title ?? 'Chatbot'}</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{home.data.ai.model ?? 'The model'} on our own Ollama answers, and it can be wrong.</p>
          </div>
          <div className="flex gap-2">
            <Sheet>
              <SheetTrigger asChild>
                <Button size="sm" variant="outline" className="lg:hidden">
                  <History /> History
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 overflow-y-auto p-4">
                <SheetHeader className="p-0">
                  <SheetTitle>Conversations</SheetTitle>
                </SheetHeader>
                {list}
              </SheetContent>
            </Sheet>
            {conversationId && (
              <Button asChild size="sm" variant="outline" className="lg:hidden">
                <Link to="/chatbot">
                  <MessageSquarePlus /> New chat
                </Link>
              </Button>
            )}
          </div>
        </header>

        <div className="mt-6 flex flex-1 flex-col">
          <ChatThread chat={chat} greeting={first ? `Hi ${first}, what can I help with?` : 'What can I help with?'} page={null} />
        </div>
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

/** Today, Yesterday, the last week, and the rest — as people look for a conversation. */
function groupOf(iso: string): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(new Date()) - day(new Date(iso))) / 86_400_000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Earlier this week' : days < 30 ? 'This month' : 'Older'
}

function ConversationList({
  conversations,
  current,
  onForget,
  onRename,
}: {
  conversations: Conversation[]
  current: string | null
  onForget: (conversation: Conversation) => void
  onRename: (conversation: Conversation, title: string) => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const needle = search.trim().toLowerCase()
  const shown = needle ? conversations.filter((c) => c.title.toLowerCase().includes(needle)) : conversations
  const groups = new Map<string, Conversation[]>()
  for (const c of shown) groups.set(groupOf(c.updatedAt), [...(groups.get(groupOf(c.updatedAt)) ?? []), c])

  return (
    <nav aria-label="Conversations" className="space-y-3">
      <Button asChild variant="outline" size="sm" className="w-full justify-start">
        <Link to="/chatbot">
          <MessageSquarePlus /> New chat
        </Link>
      </Button>
      {conversations.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" className="h-8 pl-8 text-sm" />
        </div>
      )}
      {conversations.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">Your conversations will be listed here. Only you can see them.</p>
      ) : shown.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">No conversation’s name has “{search.trim()}” in it.</p>
      ) : (
        [...groups.entries()].map(([group, items]) => (
          <div key={group}>
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group}</p>
            <ul className="space-y-0.5">
              {items.map((c) =>
                editing === c.id ? (
                  <li key={c.id}>
                    <RenameField
                      title={c.title}
                      onDone={async (title) => {
                        setEditing(null)
                        if (title && title !== c.title) await onRename(c, title)
                      }}
                    />
                  </li>
                ) : (
                  <li key={c.id} className="group/item flex items-center gap-0.5">
                    <Link
                      to={`/chatbot/${c.id}`}
                      aria-current={c.id === current ? 'page' : undefined}
                      className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted ${c.id === current ? 'bg-secondary font-medium text-secondary-foreground' : ''}`}
                      title={c.title}
                    >
                      {c.title}
                    </Link>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="rounded p-1.5 text-muted-foreground opacity-0 group-hover/item:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
                          aria-label={`More for “${c.title}”`}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(c.id)}>
                          <Pencil /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => onForget(c)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ),
              )}
            </ul>
          </div>
        ))
      )}
    </nav>
  )
}

/** Enter keeps the new name, Escape or leaving the field keeps the old one. */
function RenameField({ title, onDone }: { title: string; onDone: (title: string | null) => Promise<void> }) {
  const [value, setValue] = useState(title)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void onDone(value.trim() || null)
  }
  return (
    <form onSubmit={submit}>
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && void onDone(null)}
        onBlur={() => void onDone(null)}
        aria-label="Conversation name"
        maxLength={120}
        className="h-8 text-sm"
      />
    </form>
  )
}
