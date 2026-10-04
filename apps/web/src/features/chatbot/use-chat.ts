import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/api-client.ts'
import { chatbotApi, type ChatEvent, type Conversation, type Feedback, type Message, type PageContext } from './api.ts'

/** A message on screen: stored, or the answer still being written. */
export type Shown = Message & { streaming?: boolean; error?: string; stopped?: boolean }

export type Chat = {
  messages: Shown[]
  /** The conversation is being opened. */
  loading: boolean
  loadError: string | null
  busy: boolean
  send: (text: string) => Promise<void>
  /** Write the last answer again. */
  regenerate: () => Promise<void>
  stop: () => void
  feedback: (message: Message, value: Feedback | null) => Promise<void>
}

/**
 * One conversation, as the full page and the dock both show it: opens the
 * conversation `conversationId` names (or starts empty), sends questions and
 * reads the answer as it streams, stops it, writes the last one again, and
 * marks answers useful or not.
 *
 * `onConversation` hears of the conversation an answer went into — a new one
 * the moment it is made, so the caller can take its URL or remember it;
 * `onTitle` hears of the name the model gives a new one; `context` says which
 * page the question is asked from.
 */
export function useChat({
  conversationId,
  onConversation,
  onTitle,
  onSettled,
  context,
}: {
  conversationId: string | null
  onConversation: (conversation: Conversation, created: boolean) => void
  onTitle?: (conversation: Conversation) => void
  /** After every answer, finished or not: time to refresh a conversation list. */
  onSettled?: () => void
  context?: () => PageContext | null
}): Chat {
  const [messages, setMessages] = useState<Shown[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const stopper = useRef<AbortController | null>(null)
  // A conversation this chat just started: its id changes, its messages are already here.
  const created = useRef<string | null>(null)

  // Open the conversation the id names, unless this chat just made it.
  useEffect(() => {
    if (conversationId === loadedFor) return
    if (conversationId && conversationId === created.current) {
      setLoadedFor(conversationId)
      return
    }
    stopper.current?.abort()
    setLoadError(null)
    if (!conversationId) {
      setMessages([])
      setLoadedFor(null)
      return
    }
    let stale = false
    chatbotApi
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

  // Stop a running answer when the chat goes away.
  useEffect(() => () => stopper.current?.abort(), [])

  const run = useCallback(
    async (body: { message: string; regenerate?: boolean }, shown: (m: Shown[]) => Shown[]) => {
      setBusy(true)
      const now = new Date().toISOString()
      const pending: Shown = { id: -Date.now() - 1, role: 'assistant', content: '', steps: [], model: null, feedback: null, createdAt: now, streaming: true }
      setMessages((m) => [...shown(m), pending])
      const update = (change: (p: Shown) => Shown) => setMessages((m) => [...m.slice(0, -1), change(m.at(-1)!)])

      const controller = new AbortController()
      stopper.current = controller
      try {
        await chatbotApi.ask(
          { ...body, conversationId, context: context?.() ?? null },
          (event: ChatEvent) => {
            switch (event.type) {
              case 'conversation':
                if (event.conversation.id !== conversationId) created.current = event.conversation.id
                onConversation(event.conversation, event.conversation.id !== conversationId)
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
              case 'title':
                onTitle?.(event.conversation)
                break
              case 'error':
                update((p) => ({ ...p, streaming: false, error: event.message }))
                break
            }
          },
          controller.signal,
        )
        if (controller.signal.aborted) update((p) => (p.streaming ? { ...p, streaming: false, stopped: true } : p))
      } catch (err) {
        update((p) => ({ ...p, streaming: false, error: err instanceof ApiError ? err.message : 'The chatbot could not answer. Try again.' }))
      } finally {
        stopper.current = null
        setBusy(false)
        onSettled?.()
      }
    },
    [conversationId, context, onConversation, onTitle, onSettled],
  )

  const send = useCallback(
    async (text: string) => {
      const question = text.trim()
      if (!question || busy) return
      const asked: Shown = { id: -Date.now(), role: 'user', content: question, steps: [], model: null, feedback: null, createdAt: new Date().toISOString() }
      await run({ message: question }, (m) => [...m, asked])
    },
    [busy, run],
  )

  const regenerate = useCallback(async () => {
    if (busy || !conversationId) return
    // Drop the last answer (or the failed attempt at one); the question stays.
    await run({ message: '', regenerate: true }, (m) => (m.at(-1)?.role === 'assistant' ? m.slice(0, -1) : m))
  }, [busy, conversationId, run])

  const feedback = useCallback(async (message: Message, value: Feedback | null) => {
    setMessages((m) => m.map((x) => (x.id === message.id ? { ...x, feedback: value } : x)))
    try {
      await chatbotApi.feedback(message.id, value)
    } catch {
      setMessages((m) => m.map((x) => (x.id === message.id ? { ...x, feedback: message.feedback } : x)))
    }
  }, [])

  return {
    messages,
    loading: loadedFor !== conversationId && !loadError,
    loadError,
    busy,
    send,
    regenerate,
    stop: () => stopper.current?.abort(),
    feedback,
  }
}

/** The page the browser is on, as the chatbot is told it: path and query, and the tab's title without the portal's name. */
export function currentPage(): PageContext {
  return { path: `${window.location.pathname}${window.location.search}`.slice(0, 500), title: document.title.replace(/\s+—\s+e-IDP$/, '').slice(0, 200) }
}
