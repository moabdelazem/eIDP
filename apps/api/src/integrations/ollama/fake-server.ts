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
import { Hono, type Context } from 'hono'

/** Ollama's streaming shape: one JSON object per line. */
function ndjson(c: Context, lines: object[]) {
  return c.body(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 200, { 'content-type': 'application/x-ndjson' })
}

export type FakeOllamaMode = 'ok' | 'invent-line' | 'bad-json-once' | 'bad-json' | 'no-model' | 'slow' | 'rogue-tool'

type ChatRequest = {
  model: string
  messages: { role: string; content: string; tool_name?: string; tool_calls?: unknown[] }[]
  format?: unknown
  stream?: boolean
  tools?: { function: { name: string } }[]
  options?: { num_ctx?: number; temperature?: number }
}

/**
 * The assistant's side: which tool a question calls for, by its words — a
 * stand-in for the model's judgement, deterministic so tests can rely on it.
 * Only tools the request offers are ever called, as a real model would.
 */
function pickTool(question: string, offered: string[]): { name: string; arguments: Record<string, unknown> } | null {
  const q = question.toLowerCase()
  const rules: [RegExp, string, (m: RegExpMatchArray) => Record<string, unknown>][] = [
    [/failing|broken/, 'jenkins_failing', () => ({})],
    [/builds? (?:of|for|with) (\S+)/, 'jenkins_builds', (m) => ({ query: m[1], window: '7d' })],
    [/my requests?/, 'my_requests', () => ({})],
    [/who owns (\S+)/, 'get_system', (m) => ({ name: m[1]!.replace(/\?$/, '') })],
    [/config(?:uration)? of (\S+) in (\S+)/, 'get_application', (m) => ({ name: m[1], system: m[2]!.replace(/\?$/, '') })],
    [/(?:find|which|what) (.+?) (?:apps?|applications?)/, 'search_applications', (m) => ({ query: m[1] })],
  ]
  for (const [pattern, name, args] of rules) {
    const match = q.match(pattern)
    if (match && offered.includes(name)) return { name, arguments: args(match) }
  }
  return null
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
    if (body.stream) return assistantTurn(c, body)
    // A request's risk summary: its schema asks for reasonConcerns.
    if (JSON.stringify(body.format ?? {}).includes('reasonConcerns')) {
      const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
      const caution = /^- \(caution\) (.+)$/m.exec(user)?.[1]
      const reason = /^Reason given: "(.*)"$/m.exec(user)?.[1] ?? ''
      const answer = {
        summary: caution ? `Weigh this before approving: ${caution}` : 'Nothing stands out; the request matches its reason.',
        reasonConcerns: reason.split(/\s+/).length < 6 ? ['The reason does not say who needs this or what for.'] : [],
      }
      return c.json({ model: body.model, message: { role: 'assistant', content: JSON.stringify(answer) }, done: true, total_duration: 900_000_000, prompt_eval_count: 400 })
    }

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

  /**
   * One streamed assistant turn: a tool call when the question needs one and
   * no tool has answered yet, else an answer — from the tool's result when
   * there is one, carrying its first link through as a markdown link.
   */
  function assistantTurn(c: Context, body: ChatRequest) {
    const last = body.messages.at(-1)!
    const question = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const offered = (body.tools ?? []).map((t) => t.function.name)
    const lines: object[] = []
    const chunk = (message: object, done = false) =>
      lines.push({ model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', ...message }, done })

    if (last.role === 'user') {
      const call = mode === 'rogue-tool' ? { name: 'approve_all_requests', arguments: {} } : pickTool(question, offered)
      if (call) {
        chunk({ tool_calls: [{ function: call }] })
        lines.push({ model: body.model, done: true, done_reason: 'stop', prompt_eval_count: 900 })
        return ndjson(c, lines)
      }
    }
    let answer: string
    if (last.role === 'tool') {
      const link = /"link":"([^"]+)"/.exec(last.content)?.[1]
      const error = /"error":"([^"]+)"/.exec(last.content)?.[1]
      answer = error ? `I could not find that: ${error}` : `Here is what I found: ${last.content.slice(0, 240)}${link ? `\n\n[Open it](${link})` : ''}`
    } else {
      answer = `**Answer.** ${question.slice(0, 80)} — here is a general explanation.\n\n- First point\n- Second point\n\n\`\`\`bash\ngit status\n\`\`\``
    }
    for (let i = 0; i < answer.length; i += 16) chunk({ content: answer.slice(i, i + 16) })
    lines.push({ model: body.model, done: true, done_reason: 'stop', prompt_eval_count: 1200, eval_count: 80 })
    return ndjson(c, lines)
  }

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
