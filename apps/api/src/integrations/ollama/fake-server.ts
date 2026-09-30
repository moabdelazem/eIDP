/**
 * A small stand-in for Ollama, for tests and for running the portal's AI
 * features without a model.
 *
 *   pnpm --filter @eidp/api ollama:fake
 *   OLLAMA_URL=http://localhost:11500
 *
 * `/api/chat` answers the way a model would for the build explainer: it reads
 * the numbered log excerpt it was given, cites the lines that look like
 * errors, and answers in the requested JSON. Behaviour can be switched to what
 * a real model sometimes does — invent a line number, break its JSON — or to
 * a missing model or a slow answer.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

export type FakeOllamaMode = 'ok' | 'invent-line' | 'bad-json-once' | 'bad-json' | 'no-model' | 'slow'

type ChatRequest = {
  model: string
  messages: { role: string; content: string }[]
  format?: unknown
  stream?: boolean
  options?: { num_ctx?: number; temperature?: number }
}

export function createFakeOllama({ models = ['qwen2.5:latest'] }: { models?: string[] } = {}) {
  let mode: FakeOllamaMode = 'ok'
  let badOnce = false
  /** Every chat request, for tests to read what the model was sent. */
  const requests: ChatRequest[] = []

  const app = new Hono()

  app.get('/api/tags', (c) => c.json({ models: models.map((name) => ({ name, model: name, size: 4_700_000_000 })) }))

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<ChatRequest>()
    requests.push(body)
    const known = models.some((m) => m === body.model || m === `${body.model}:latest`)
    if (mode === 'no-model' || !known) return c.json({ error: `model '${body.model}' not found` }, 404)
    if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 3000))

    const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
    // Lines of the excerpt are "<n>: <text>"; cite those that read like errors.
    const errors = [...user.matchAll(/^(\d+): (.*(?:ERROR|Failures: [1-9]|FAILURE).*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2]! }))
    const failedStage = /^Failed stage: (.+)$/m.exec(user)?.[1] ?? 'an unknown stage'
    const answer = {
      summary: `The ${failedStage} stage failed: ${errors[0]?.text.trim() ?? 'the log does not say why'}.`,
      cause: errors.length
        ? `The build stopped in ${failedStage}. ${errors.length} line(s) report errors, starting at line ${errors[0]!.n}.`
        : 'The log excerpt does not show a clear cause.',
      category: /Tests run|Failures:/.test(user) ? 'test_failure' : 'unknown',
      confidence: errors.length ? 'high' : 'low',
      evidence: [...errors.slice(0, 3).map((e) => e.n), ...(mode === 'invent-line' ? [999_999] : [])],
      nextSteps: ['Run the failing test locally with the same branch.', 'Compare with the last passing build.'],
    }

    let content = JSON.stringify(answer)
    if (mode === 'bad-json' || (mode === 'bad-json-once' && !badOnce)) {
      badOnce = true
      content = content.slice(0, content.length / 2)
    }
    return c.json({
      model: body.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content },
      done: true,
      total_duration: 1_250_000_000,
      prompt_eval_count: Math.ceil(user.length / 3),
      eval_count: 120,
    })
  })

  return {
    app,
    requests,
    setMode: (next: FakeOllamaMode) => {
      mode = next
      badOnce = false
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_OLLAMA_PORT ?? 11500)
  serve({ fetch: createFakeOllama().app.fetch, port })
  console.log(`fake Ollama on http://localhost:${port}`)
  console.log(`  OLLAMA_URL=http://localhost:${port}`)
}
