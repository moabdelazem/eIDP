import { api, apiStream } from '@/lib/api-client.ts'

/** Mirrors services/chatbot.ts. */
export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string }

export type Feedback = 'up' | 'down'

export type Message = {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** What the chatbot looked up to answer. */
  steps: string[]
  model: string | null
  feedback: Feedback | null
  createdAt: string
}

/** The page a question is asked from. */
export type PageContext = { path: string; title?: string }

export type ChatEvent =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'step'; label: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; message: Message }
  | { type: 'title'; conversation: Conversation }
  | { type: 'error'; message: string }

export type Home = { ai: { configured: boolean; model: string | null }; conversations: Conversation[] }

const conversationPath = (id: string) => `/chatbot/conversations/${encodeURIComponent(id)}`

export const chatbotApi = {
  home: () => api<Home>('/chatbot'),
  conversation: (id: string) => api<{ conversation: Conversation; messages: Message[] }>(conversationPath(id)),
  rename: (id: string, title: string) => api<Conversation>(conversationPath(id), { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: (id: string) => api<void>(conversationPath(id), { method: 'DELETE' }),
  feedback: (messageId: number, feedback: Feedback | null) =>
    api<Message>(`/chatbot/messages/${messageId}/feedback`, { method: 'PUT', body: JSON.stringify({ feedback }) }),
  ask: (
    body: { message: string; conversationId: string | null; context?: PageContext | null; regenerate?: boolean },
    onEvent: (event: ChatEvent) => void,
    signal: AbortSignal,
  ) => apiStream<ChatEvent>('/chatbot/ask', body, onEvent, signal),
}
