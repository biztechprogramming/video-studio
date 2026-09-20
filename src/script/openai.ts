import { requireEnv } from '../config.ts'

// Reasoning models (gpt-5.x and friends) charge their internal thinking to
// max_completion_tokens, and a prompt that asks for 300 words of narration can
// easily think for a couple of thousand tokens first. Callers size the visible
// reply; this is the thinking allowance added on top.
const REASONING_HEADROOM = 3000
// Ceiling for the adaptive retry below, so a pathological run can't spend
// unbounded tokens.
const MAX_BUDGET = 16000

// Which sampling parameters a given model has already rejected in this
// process, so a five-segment episode doesn't burn (and log) one failed round
// trip per call discovering the same thing.
const unsupportedParams = new Map<string, Set<string>>()

/**
 * Minimal OpenAI chat client. The project already talks to OpenAI over plain
 * fetch for TTS, so pulling in the SDK just for JSON chat isn't worth the
 * dependency.
 */
export async function chatJson<T>(opts: {
  model: string
  system: string
  user: string
  /**
   * Ceiling on the *visible* reply. Reasoning models bill their thinking to
   * the same budget, so headroom is added on top — see REASONING_HEADROOM.
   */
  maxTokens?: number
  temperature?: number
}): Promise<T> {
  const apiKey = await requireEnv('OPENAI_API_KEY', {
    hint: 'Used to write the narration script and to synthesize the voice. Create one at https://platform.openai.com/api-keys',
    example: 'sk-proj-...',
  })

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    response_format: { type: 'json_object' as const },
    max_completion_tokens: (opts.maxTokens ?? 2000) + REASONING_HEADROOM,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  }
  for (const param of unsupportedParams.get(opts.model) ?? []) delete body[param]

  const maxAttempts = 3
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 120_000)
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        const apiError = parseError(text)
        // Newer models accept only the default temperature (and may drop other
        // sampling knobs). Rather than making every caller know which model
        // supports what, drop the offending parameter and try again.
        if (res.status === 400 && apiError?.code === 'unsupported_value' && apiError.param && apiError.param in body) {
          process.stderr.write(`  ${opts.model} doesn't accept '${apiError.param}'; dropping it\n`)
          delete body[apiError.param]
          const known = unsupportedParams.get(opts.model) ?? new Set<string>()
          known.add(apiError.param)
          unsupportedParams.set(opts.model, known)
          attempt--
          continue
        }
        if (res.status === 404 || apiError?.code === 'model_not_found' || apiError?.param === 'model') {
          throw new Error(
            `OpenAI rejected the model "${opts.model}": ${apiError?.message ?? text.slice(0, 300)}\n` +
            `  Set OPENAI_SCRIPT_MODEL in .env to a model your key can use.`,
          )
        }
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`OpenAI ${res.status}: ${apiError?.message ?? text.slice(0, 400)}`)
        }
        throw new RetryableError(`OpenAI ${res.status}: ${text.slice(0, 200)}`)
      }
      const json = JSON.parse(text)
      const choice = json.choices?.[0]
      const content = choice?.message?.content
      if (!content) {
        // A reasoning model that runs out of budget mid-thought returns an
        // empty string with finish_reason "length" — not an error response, so
        // it would otherwise look like a mysteriously blank script. Give it
        // more room and try again before giving up.
        const budget = body.max_completion_tokens as number
        if (choice?.finish_reason === 'length' && budget < MAX_BUDGET) {
          body.max_completion_tokens = Math.min(MAX_BUDGET, budget * 2)
          process.stderr.write(
            `  ${opts.model} used its whole ${budget}-token budget on reasoning; retrying with ${body.max_completion_tokens}\n`,
          )
          attempt--
          continue
        }
        throw new Error(
          `OpenAI returned no content (finish_reason: ${choice?.finish_reason ?? 'unknown'}). ` +
          `Response: ${text.slice(0, 200)}`,
        )
      }
      return JSON.parse(content) as T
    } catch (err) {
      lastErr = err
      const retryable = err instanceof RetryableError || (err instanceof Error && err.name === 'AbortError')
      if (!retryable || attempt === maxAttempts) {
        if (err instanceof RetryableError) break
        throw err
      }
      const backoff = 1500 * 2 ** (attempt - 1)
      process.stderr.write(`  OpenAI attempt ${attempt}/${maxAttempts} failed; retrying in ${backoff / 1000}s\n`)
      await new Promise((r) => setTimeout(r, backoff))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`OpenAI request failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

class RetryableError extends Error {}

interface ApiError {
  message?: string
  code?: string
  param?: string
}

function parseError(text: string): ApiError | undefined {
  try {
    return JSON.parse(text).error as ApiError
  } catch {
    return undefined
  }
}
