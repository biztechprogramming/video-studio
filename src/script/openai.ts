import { requireEnv } from '../config.ts'

/**
 * Minimal OpenAI chat client. The project already talks to OpenAI over plain
 * fetch for TTS, so pulling in the SDK just for JSON chat isn't worth the
 * dependency.
 */
export async function chatJson<T>(opts: {
  model: string
  system: string
  user: string
  /** Rough ceiling on the reply; scripts are short. */
  maxTokens?: number
  temperature?: number
}): Promise<T> {
  const apiKey = await requireEnv('OPENAI_API_KEY', {
    hint: 'Used to write the narration script and to synthesize the voice. Create one at https://platform.openai.com/api-keys',
    example: 'sk-proj-...',
  })

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    response_format: { type: 'json_object' as const },
    max_completion_tokens: opts.maxTokens ?? 2000,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  }

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
        if (res.status === 404 || /model/i.test(text) && res.status === 400) {
          throw new Error(
            `OpenAI rejected the model "${opts.model}": ${text.slice(0, 300)}\n` +
            `  Set OPENAI_SCRIPT_MODEL in .env to a model your key can use.`,
          )
        }
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`)
        }
        throw new RetryableError(`OpenAI ${res.status}: ${text.slice(0, 200)}`)
      }
      const json = JSON.parse(text)
      const content = json.choices?.[0]?.message?.content
      if (!content) throw new Error(`OpenAI returned no content: ${text.slice(0, 300)}`)
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
