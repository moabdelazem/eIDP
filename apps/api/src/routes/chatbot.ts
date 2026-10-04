import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { ollamaConfig } from '../integrations/ollama/index.ts'
import { ApiError } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import * as chatbot from '../services/chatbot.ts'

const Ask = z
  .object({
    conversationId: z.string().max(64).nullable().optional(),
    message: z.string().max(8000).optional().default(''),
    /** The page it is asked from: a portal path, and that page's title. */
    context: z
      .object({ path: z.string().max(500).regex(/^\//, 'A portal path.'), title: z.string().max(200).optional() })
      .nullable()
      .optional(),
    /** Write the last answer again instead of asking something new. */
    regenerate: z.boolean().optional().default(false),
  })
  .refine((a) => a.regenerate || a.message.trim().length > 0, { message: 'Ask something.', path: ['message'] })

/** The chatbot. Everyone holds `ai.chat`; what it can look up is scoped per person by the service. */
export const chatbotRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .use('*', requirePermission('ai.chat'))

  /** Whether the chatbot is there, and this person's conversations. */
  .get('/', async (c) => {
    const ai = ollamaConfig()
    return c.json({
      ai: { configured: ai !== null, model: ai?.model ?? null },
      conversations: await chatbot.listConversations(c.get('jwtPayload').sub),
    })
  })

  .get('/conversations/:id', async (c) => c.json(await chatbot.readConversation(c.req.param('id'), c.get('jwtPayload').sub)))

  .patch('/conversations/:id', validate('json', z.object({ title: z.string().max(200) })), async (c) =>
    c.json(await chatbot.renameConversation(c.req.param('id'), c.get('jwtPayload').sub, c.req.valid('json').title)),
  )

  .delete('/conversations/:id', async (c) => {
    await chatbot.deleteConversation(c.req.param('id'), c.get('jwtPayload').sub)
    return c.body(null, 204)
  })

  .put('/messages/:id/feedback', validate('json', z.object({ feedback: z.enum(['up', 'down']).nullable() })), async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(404, 'message_not_found', 'There is no such answer.')
    return c.json(await chatbot.setFeedback(id, c.get('jwtPayload').sub, c.req.valid('json').feedback))
  })

  /**
   * Asks, and streams the answer as server-sent events: `conversation`, then
   * `step`s and `delta`s, then `done` (and `title` for a new conversation) —
   * or `error`. Failures before the first event (not configured, busy, not
   * yours) are ordinary JSON errors, so the page reads them like any other.
   */
  .post('/ask', validate('json', Ask), async (c) => {
    const { conversationId, message, context, regenerate } = c.req.valid('json')
    const claims = c.get('jwtPayload')
    const me = { uid: claims.sub, name: claims.name, mail: claims.mail }
    const access = await accessFrom(c)
    if (!ollamaConfig()) throw new ApiError(503, 'ollama_not_configured', 'The portal’s AI is not configured: OLLAMA_URL is not set.')
    await chatbot.assertCanAsk(conversationId ?? null, me.uid, regenerate)

    return streamSSE(c, async (stream) => {
      // Closing the page stops the model rather than letting it write to no one.
      const stop = new AbortController()
      stream.onAbort(() => stop.abort())
      try {
        await chatbot.ask(
          { conversationId: conversationId ?? null, text: message, context, regenerate },
          me,
          access,
          (event) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
          stop.signal,
        )
      } catch (err) {
        const text = err instanceof ApiError ? err.message : 'The chatbot could not answer. Try again.'
        if (!(err instanceof ApiError)) console.error('chatbot failed', err)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: text }) })
      }
    })
  })
