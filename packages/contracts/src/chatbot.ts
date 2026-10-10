/** The chatbot: what `/chatbot` sends, and the events its answer streams (apps/api modules/chatbot/service.ts). */

/**
 * The portal's chatbot: Qwen on our own Ollama, as an agent inside the
 * portal. General engineering it answers from what the model knows; anything
 * about us — systems, owners, configuration, requests, approvals, builds,
 * pipelines, a team's week, what you may do — from the
 * portal's data, through read-only tools (`modules/chatbot/tools.ts`) offered only as
 * far as the person asking may see. It never acts: for a request it hands
 * over the form filled in, and the person submits it.
 *
 * It knows the page it is asked from (`context`), so "why did this fail?" on
 * a build page is about that build.
 *
 * Conversations are kept per person; only their owner can read them. Tool
 * results live for the turn that used them and are not stored: the next turn
 * asks again, which keeps the history small and the data current. The tables
 * keep their first name, `assistant_*` — renaming them is a migration for a
 * word.
 */

export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string }

export type Feedback = 'up' | 'down'

export type StoredMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** What the chatbot looked up to answer, as shown to the person. */
  steps: string[]
  model: string | null
  feedback: Feedback | null
  createdAt: string
}

/** The page a question is asked from, as the browser names it. */
export type PageContext = { path: string; title?: string }

/** What the page is told while an answer is made. */
export type ChatEvent =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'step'; label: string }
  | { type: 'delta'; text: string }
  /** Text streamed so far this turn was a preamble to tool calls; drop it. */
  | { type: 'reset' }
  | { type: 'done'; message: StoredMessage }
  /** The conversation was named, after its first answer. */
  | { type: 'title'; conversation: Conversation }
  | { type: 'error'; message: string }

/** `GET /chatbot`: whether the model is there, and your conversations. */
export type Home = { ai: { configured: boolean; model: string | null }; conversations: Conversation[] }

/** `GET /chatbot/conversations/:id`. */
export type Thread = { conversation: Conversation; messages: StoredMessage[] }

/** What `POST /chatbot/ask` takes. */
export type Ask = { message: string; conversationId: string | null; context?: PageContext | null; regenerate?: boolean }
