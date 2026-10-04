import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Bot, Maximize2, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useSession } from '@/features/auth/session-context.tsx'
import { onAskChatbot } from '@/lib/ask-chatbot.ts'
import { chatbotApi, type Conversation, type Home } from './api.ts'
import { ChatThread } from './chat-thread.tsx'
import { currentPage, useChat } from './use-chat.ts'

const KEPT = 'eidp.chatbot.dock'

function kept(): string | null {
  try {
    return sessionStorage.getItem(KEPT)
  } catch {
    return null
  }
}
function keep(id: string | null) {
  try {
    if (id) sessionStorage.setItem(KEPT, id)
    else sessionStorage.removeItem(KEPT)
  } catch {
    // Private window: the dock forgets its conversation on reload.
  }
}

/**
 * The chatbot on every page: a button at the corner of the screen, or Ctrl/⌘ J,
 * opens the chat in a panel over the page — told which page it is, so "why did
 * this build fail?" is about the build underneath. Its conversation carries on
 * from page to page for the session, and opens in the full page with one
 * click. Following a link in an answer closes the panel onto that page.
 * Other pages can hand it a question (`askChatbot` in lib/ask-chatbot.ts).
 *
 * Shown to everyone who holds `ai.chat`, but not on the chatbot's own page.
 */
export function ChatbotDock() {
  const { can, loaded } = useProfile()
  const { pathname } = useLocation()
  const onChatbot = pathname === '/chatbot' || pathname.startsWith('/chatbot/')
  if (!loaded || !can('ai.chat') || onChatbot) return null
  return <Dock />
}

function Dock() {
  const navigate = useNavigate()
  const { session } = useSession()
  const [open, setOpen] = useState(false)
  const [home, setHome] = useState<Home | null>(null)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(kept)

  // Ctrl/⌘ J, from anywhere — the browser's own downloads shortcut gives way inside the portal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Whether the chatbot is there at all, and the kept conversation's name — asked once, on first open.
  useEffect(() => {
    if (!open || home) return
    chatbotApi
      .home()
      .then((h) => {
        setHome(h)
        const found = h.conversations.find((c) => c.id === conversationId) ?? null
        setConversation(found)
        if (conversationId && !found) {
          setConversationId(null)
          keep(null)
        }
      })
      .catch(() => setHome({ ai: { configured: false, model: null }, conversations: [] }))
  }, [open, home, conversationId])

  const chat = useChat({
    conversationId,
    onConversation: useCallback((c: Conversation) => {
      setConversation(c)
      setConversationId(c.id)
      keep(c.id)
    }, []),
    onTitle: useCallback((c: Conversation) => setConversation(c), []),
    context: currentPage,
  })

  // Another page asks on the person's behalf ("Ask the chatbot" on a failed run): open and send it.
  // While an answer is still coming, it only opens: `send` refuses a second question.
  const { send } = chat
  useEffect(
    () =>
      onAskChatbot((question) => {
        setOpen(true)
        void send(question)
      }),
    [send],
  )

  const fresh = () => {
    chat.stop()
    setConversation(null)
    setConversationId(null)
    keep(null)
  }
  const first = session?.name.split(/\s+/)[0]

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open the chatbot"
            aria-keyshortcuts="Control+J Meta+J"
            className="chat-launcher fixed right-6 bottom-6 z-40 flex size-12 items-center justify-center rounded-full bg-[var(--rail)] text-[var(--rail-foreground)] shadow-lg ring-1 ring-[var(--rail-border)] transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/60 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:scale-100 data-[busy=true]:animate-pulse"
            data-busy={chat.busy && !open}
          >
            <Bot className="size-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          Chatbot <Kbd>Ctrl J</Kbd>
        </TooltipContent>
      </Tooltip>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            document.querySelector<HTMLTextAreaElement>('[data-chatbot-input]')?.focus()
          }}
        >
          <SheetHeader className="flex-row items-center gap-2 border-b px-4 py-3 pr-12">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-[var(--chart-1)]" aria-hidden>
              <Bot className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-sm">{conversation?.title ?? 'Chatbot'}</SheetTitle>
              <SheetDescription className="truncate text-xs">{home?.ai.model ?? 'The model'} on our own Ollama — it can be wrong</SheetDescription>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8" onClick={fresh} disabled={!conversationId} aria-label="New chat">
                  <MessageSquarePlus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New chat</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label="Open in the full page"
                  onClick={() => {
                    setOpen(false)
                    navigate(conversationId ? `/chatbot/${conversationId}` : '/chatbot')
                  }}
                >
                  <Maximize2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in the full page</TooltipContent>
            </Tooltip>
          </SheetHeader>

          {home && !home.ai.configured ? (
            <p className="p-4 text-sm text-muted-foreground">The chatbot is not set up: it needs the portal’s Ollama, and OLLAMA_URL is not set on the API.</p>
          ) : (
            <ChatThread
              chat={chat}
              compact
              greeting={first ? `Hi ${first}, what can I help with?` : 'What can I help with?'}
              page={open ? currentPage() : null}
              onNavigate={() => setOpen(false)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}
