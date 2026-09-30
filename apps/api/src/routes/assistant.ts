import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { ollamaConfig } from '../integrations/ollama/index.ts'
import { ApiError } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import * as assistant from '../services/assistant.ts'

const Ask = z.object({
  conversationId: z.string().max(64).nullable().optional(),
  message: z.string().min(1, 'Ask something.').max(8000),
})

/** The assistant. Everyone holds `ai.chat`; what it can look up is scoped per person by the service. */
export const assistantRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .use('*', requirePermission('ai.chat'))

  /** Whether the assistant is there, and this person's conversations. */
  .get('/', async (c) => {
    const ai = ollamaConfig()
    return c.json({
      ai: { configured: ai !== null, model: ai?.model ?? null },
      conversations: await assistant.listConversations(c.get('jwtPayload').sub),
    })
  })

  .get('/conversations/:id', async (c) => c.json(await assistant.readConversation(c.req.param('id'), c.get('jwtPayload').sub)))

  .delete('/conversations/:id', async (c) => {
    await assistant.deleteConversation(c.req.param('id'), c.get('jwtPayload').sub)
    return c.body(null, 204)
  })

  /**
   * Asks, and streams the answer as server-sent events: `conversation`, then
   * `step`s and `delta`s, then `done` — or `error`. Failures before the first
   * event (not configured, busy, not yours) are ordinary JSON errors, so the
   * page reads them like any other.
   */
  .post('/ask', validate('json', Ask), async (c) => {
    const { conversationId, message } = c.req.valid('json')
    const claims = c.get('jwtPayload')
    const actor = { uid: claims.sub, name: claims.name }
    const access = await accessFrom(c)
    if (!ollamaConfig()) throw new ApiError(503, 'ollama_not_configured', 'The portal’s AI is not configured: OLLAMA_URL is not set.')
    await assistant.assertCanAsk(conversationId ?? null, actor.uid)

    return streamSSE(c, async (stream) => {
      // Closing the page stops the model rather than letting it write to no one.
      const stop = new AbortController()
      stream.onAbort(() => stop.abort())
      try {
        await assistant.ask(
          { conversationId: conversationId ?? null, text: message },
          actor,
          access,
          (event) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
          stop.signal,
        )
      } catch (err) {
        const text = err instanceof ApiError ? err.message : 'The assistant could not answer. Try again.'
        if (!(err instanceof ApiError)) console.error('assistant failed', err)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: text }) })
      }
    })
  })
