import { api, apiStream } from '@/lib/api-client.ts'

/** Mirrors services/assistant.ts. */
export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string }

export type Message = {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** What the assistant looked up to answer. */
  steps: string[]
  model: string | null
  createdAt: string
}

export type AssistantEvent =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'step'; label: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; message: Message }
  | { type: 'error'; message: string }

export const assistantApi = {
  home: () => api<{ ai: { configured: boolean; model: string | null }; conversations: Conversation[] }>('/assistant'),
  conversation: (id: string) => api<{ conversation: Conversation; messages: Message[] }>(`/assistant/conversations/${encodeURIComponent(id)}`),
  remove: (id: string) => api<void>(`/assistant/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  ask: (message: string, conversationId: string | null, onEvent: (event: AssistantEvent) => void, signal: AbortSignal) =>
    apiStream<AssistantEvent>('/assistant/ask', { message, conversationId }, onEvent, signal),
}
