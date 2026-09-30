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

export type Message = { role: 'system' | 'user' | 'assistant'; content: string }

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

/** The configured model and whether Ollama has it — what the UI needs to offer the feature. */
export async function status(): Promise<{ configured: boolean; model: string | null; reachable: boolean; hasModel: boolean }> {
  const ollama = ollamaConfig()
  if (!ollama) return { configured: false, model: null, reachable: false, hasModel: false }
  try {
    const res = await fetch(`${ollama.url}/api/tags`, { signal: AbortSignal.timeout(5000) })
    const { models = [] } = (await res.json()) as { models?: { name: string }[] }
    // `qwen2.5` is `qwen2.5:latest` in the list.
    const wanted = ollama.model.includes(':') ? ollama.model : `${ollama.model}:latest`
    return { configured: true, model: ollama.model, reachable: true, hasModel: models.some((m) => m.name === wanted || m.name === ollama.model) }
  } catch {
    return { configured: true, model: ollama.model, reachable: false, hasModel: false }
  }
}
