/**
 * Hands a question to the chatbot dock from anywhere, without importing the
 * chatbot: a page asks, the dock (mounted once in the shell) opens and sends
 * it. Nothing listens when the dock is not there — no `ai.chat`, or on the
 * chatbot's own page — so callers offer it only to holders of `ai.chat`.
 */
const EVENT = 'eidp:ask-chatbot'

export function askChatbot(question: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: question }))
}

/** Calls `handle` with each question asked; returns the unsubscribe. */
export function onAskChatbot(handle: (question: string) => void): () => void {
  const listener = (event: Event) => handle((event as CustomEvent<string>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
