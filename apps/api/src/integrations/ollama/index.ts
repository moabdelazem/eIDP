import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * Ollama's API, on our own machines: `/api/chat` for answers, `/api/tags` to
 * say which models are there.
 *
 * Answers are asked for as JSON against a schema (`format`), so the portal
 * reads fields rather than parsing prose. The context window is always sent
 * (`num_ctx`): Ollama's default is small, and past it the prompt is cut from
 * the front without a word — the instructions go first, and the answer is
 * then about whatever was left.
 */

export type OllamaConfig = { url: string; model: string; numCtx: number; timeoutMs: number }

/** Null when Ollama is not configured — the AI features hide rather than fail. */
export function ollamaConfig(): OllamaConfig | null {
  if (!config.OLLAMA_URL) return null
  return {
    url: config.OLLAMA_URL.replace(/\/+$/, ''),
    model: config.OLLAMA_MODEL,
    numCtx: config.OLLAMA_NUM_CTX,
    timeoutMs: config.OLLAMA_TIMEOUT_SECONDS * 1000,
  }
}

function required(): OllamaConfig {
  const ollama = ollamaConfig()
  if (!ollama) throw new ApiError(503, 'ollama_not_configured', 'The portal’s AI is not configured: OLLAMA_URL is not set.')
  return ollama
}

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> } }

export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  /** A tool's result, fed back to the model. */
  | { role: 'tool'; content: string; tool_name: string }

/** A tool the model may call, as Ollama takes it: a name, a description and a JSON schema. */
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: object } }

export type ChatResult = {
  /** The answer's text — JSON when a `format` was given. */
  content: string
  model: string
  /** Tokens the prompt took, as Ollama counted them. */
  promptTokens: number
  durationMs: number
}

/**
 * One answer, not streamed: a structured answer is only useful whole.
 * `format` is a JSON schema the answer must follow; a low temperature keeps
 * an explanation about the log rather than inventive.
 */
export async function chat(messages: Message[], { format, temperature = 0.2 }: { format?: object; temperature?: number } = {}): Promise<ChatResult> {
  const ollama = required()
  let res: Response
  try {
    res = await fetch(`${ollama.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ollama.model,
        messages,
        stream: false,
        ...(format ? { format } : {}),
        options: { temperature, num_ctx: ollama.numCtx },
      }),
      signal: AbortSignal.timeout(ollama.timeoutMs),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ApiError(504, 'ollama_timeout', `${ollama.model} took longer than ${ollama.timeoutMs / 1000}s to answer. Try again, or use a smaller model.`)
    }
    throw new ApiError(502, 'ollama_unreachable', 'Cannot reach Ollama.')
  }
  const body = (await res.json().catch(() => null)) as {
    error?: string
    model?: string
    message?: { content?: string }
    prompt_eval_count?: number
    total_duration?: number
  } | null
  if (!res.ok) {
    const detail = body?.error ?? `Ollama returned ${res.status}.`
    // A model nobody pulled answers 404 with "model 'x' not found".
    if (res.status === 404) {
      throw new ApiError(502, 'ollama_model_missing', `Ollama does not have ${ollama.model}. Pull it on the Ollama host (ollama pull ${ollama.model}) or set OLLAMA_MODEL.`)
    }
    throw new ApiError(502, 'ollama_error', detail)
  }
  return {
    content: body?.message?.content ?? '',
    model: body?.model ?? ollama.model,
    promptTokens: body?.prompt_eval_count ?? 0,
    durationMs: Math.round((body?.total_duration ?? 0) / 1e6),
  }
}

/**
 * One turn, streamed: `onDelta` gets the answer's text as it is written, and
 * the result says whether the model asked for tools instead. Qwen 2.5 decides
 * between the two per turn — a turn that calls tools usually writes nothing.
 *
 * Ollama streams newline-delimited JSON; tool calls arrive whole in one chunk.
 */
export async function chatStream(
  messages: Message[],
  { tools, onDelta, signal }: { tools?: ToolSpec[]; onDelta: (text: string) => void; signal?: AbortSignal },
): Promise<{ content: string; toolCalls: ToolCall[]; promptTokens: number; model: string }> {
  const ollama = required()
  const timeout = AbortSignal.timeout(ollama.timeoutMs)
  let res: Response
  try {
    res = await fetch(`${ollama.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ollama.model,
        messages,
        stream: true,
        ...(tools?.length ? { tools } : {}),
        options: { temperature: 0.3, num_ctx: ollama.numCtx },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err) {
    throw fetchError(err, ollama)
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (res.status === 404) {
      throw new ApiError(502, 'ollama_model_missing', `Ollama does not have ${ollama.model}. Pull it on the Ollama host (ollama pull ${ollama.model}) or set OLLAMA_MODEL.`)
    }
    throw new ApiError(502, 'ollama_error', body?.error ?? `Ollama returned ${res.status}.`)
  }

  let content = ''
  const toolCalls: ToolCall[] = []
  let promptTokens = 0
  let model = ollama.model
  let buffered = ''
  const decoder = new TextDecoder()
  const take = (line: string) => {
    if (!line.trim()) return
    const chunk = JSON.parse(line) as {
      model?: string
      message?: { content?: string; tool_calls?: ToolCall[] }
      done?: boolean
      error?: string
      prompt_eval_count?: number
    }
    if (chunk.error) throw new ApiError(502, 'ollama_error', chunk.error)
    if (chunk.model) model = chunk.model
    if (chunk.message?.content) {
      content += chunk.message.content
      onDelta(chunk.message.content)
    }
    if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls)
    if (chunk.done) promptTokens = chunk.prompt_eval_count ?? 0
  }
  try {
    for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(piece, { stream: true })
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        take(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
      }
    }
    take(buffered)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw fetchError(err, ollama)
  }
  return { content, toolCalls, promptTokens, model }
}

function fetchError(err: unknown, ollama: OllamaConfig): ApiError {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new ApiError(504, 'ollama_timeout', `${ollama.model} took longer than ${ollama.timeoutMs / 1000}s to answer. Try again, or use a smaller model.`)
  }
  if (err instanceof Error && err.name === 'AbortError') return new ApiError(408, 'ollama_aborted', 'Stopped.')
  return new ApiError(502, 'ollama_unreachable', 'Cannot reach Ollama.')
}
