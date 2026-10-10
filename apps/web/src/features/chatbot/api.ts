import { api, apiStream } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { Ask, ChatEvent, Conversation, Feedback, Home, StoredMessage, Thread } from '@eidp/contracts/chatbot'
export type { ChatEvent, Conversation, Feedback, Home, PageContext } from '@eidp/contracts/chatbot'
/** A message as the thread shows it. */
export type Message = StoredMessage

const conversationPath = (id: string) => `/chatbot/conversations/${encodeURIComponent(id)}`

export const chatbotApi = {
  home: () => api<Home>('/chatbot'),
  conversation: (id: string) => api<Thread>(conversationPath(id)),
  rename: (id: string, title: string) => api<Conversation>(conversationPath(id), { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: (id: string) => api<void>(conversationPath(id), { method: 'DELETE' }),
  feedback: (messageId: number, feedback: Feedback | null) =>
    api<StoredMessage>(`/chatbot/messages/${messageId}/feedback`, { method: 'PUT', body: JSON.stringify({ feedback }) }),
  ask: (
    body: Ask,
    onEvent: (event: ChatEvent) => void,
    signal: AbortSignal,
  ) => apiStream<ChatEvent>('/chatbot/ask', body, onEvent, signal),
}
