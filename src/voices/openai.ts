import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { gatewayDownError, openaiBaseUrl, openaiKey } from '../config.ts'
import { DEFAULT_HOST_VOICE, DEFAULT_TTS_MODEL, canAct } from './catalog.ts'

/** One thing to say, in one voice, one way. */
export interface SpeechRequest {
  text: string
  voice: string
  /** How to say it: tone, pace, accent, attitude. Ignored by models that can't act. */
  instructions?: string
}

/**
 * A text-to-speech backend. Only OpenAI is implemented, but the episode never
 * names it: voices are addressed as `provider:voice` (a bare `onyx` means
 * `openai:onyx`), so adding a second backend is a new file and a lookup entry
 * rather than a change to the renderer.
 */
export interface SpeechProvider {
  readonly id: string
  readonly model: string
  /** Stable cache key for one request under this provider's model. */
  cacheKey(req: SpeechRequest): string
  /** Write one MP3 to `outPath`. Throws on failure. */
  synthesize(req: SpeechRequest, outPath: string): Promise<void>
}

export class OpenAITTS implements SpeechProvider {
  readonly id = 'openai'
  readonly model: string
  /** The voice used when a request doesn't name one. */
  readonly voice: string
  private apiKey: string
  private baseUrl: string
  /** One warning per run, not one per line, when the model can't take direction. */
  private warnedNoDirection = false

  constructor(opts: { model?: string; voice?: string } = {}) {
    this.baseUrl = openaiBaseUrl()
    const apiKey = openaiKey(this.baseUrl)
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set. Add it to .env or your shell environment.')
    }
    this.apiKey = apiKey
    this.model = opts.model ?? process.env.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL
    this.voice = opts.voice ?? process.env.OPENAI_TTS_VOICE ?? DEFAULT_HOST_VOICE
  }

  /** True when this provider's model will act on `instructions`. */
  get acts(): boolean {
    return canAct(this.model)
  }

  cacheKey(req: SpeechRequest): string {
    // The direction is part of the identity of a clip: the same words, delivered
    // differently, are a different take and must not collide in the cache.
    const direction = this.acts ? (req.instructions ?? '') : ''
    // JSON rather than a delimiter: the direction and the text are both free
    // text, and any separator picked out of thin air is a separator one of them
    // can contain. (The previous version used literal NUL bytes, which worked
    // and quietly made this a binary file as far as git was concerned.)
    return createHash('sha256')
      .update(JSON.stringify([this.model, req.voice || this.voice, direction, req.text]))
      .digest('hex')
      .slice(0, 32)
  }

  /**
   * Generate one MP3 file at `outPath`. Throws on API failure.
   *
   * Retries transient failures — dropped TLS sockets ("TypeError: terminated"),
   * request timeouts, and 429/5xx responses — with exponential backoff. A
   * single network blip mid-run used to kill the whole recording before the
   * browser even launched; now it's retried.
   */
  async synthesize(req: SpeechRequest, outPath: string): Promise<void> {
    const maxAttempts = 4
    const perAttemptTimeoutMs = 60_000
    const voice = req.voice || this.voice
    if (req.instructions && !this.acts && !this.warnedNoDirection) {
      this.warnedNoDirection = true
      process.stderr.write(
        `  NOTE: ${this.model} ignores delivery direction, so the cast will differ in voice but not in performance.\n` +
          `        Set OPENAI_TTS_MODEL=${DEFAULT_TTS_MODEL} to let them act.\n`,
      )
    }
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), perAttemptTimeoutMs)
      try {
        const res = await fetch(`${this.baseUrl}/audio/speech`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            voice,
            input: req.text,
            response_format: 'mp3',
            ...(this.acts && req.instructions ? { instructions: req.instructions } : {}),
          }),
          signal: ac.signal,
        })
        if (!res.ok) {
          const body = await res.text()
          // 4xx (bad key, bad voice, etc.) won't fix itself — fail fast.
          // 429 / 5xx are transient — retry.
          if (res.status < 500 && res.status !== 429) {
            throw new Error(`OpenAI TTS ${res.status}: ${body.slice(0, 300)}`)
          }
          throw new RetryableError(`OpenAI TTS ${res.status}: ${body.slice(0, 200)}`)
        }
        const buf = Buffer.from(await res.arrayBuffer())
        await fs.writeFile(outPath, buf)
        return
      } catch (err) {
        lastErr = err
        const down = gatewayDownError(this.baseUrl, err)
        if (down) throw down
        // Non-retryable (4xx) errors: bail immediately.
        if (
          err instanceof Error &&
          !(err instanceof RetryableError) &&
          err.name !== 'AbortError' &&
          !isNetworkError(err)
        ) {
          throw err
        }
        if (attempt < maxAttempts) {
          const backoffMs = 1000 * 2 ** (attempt - 1) // 1s, 2s, 4s
          process.stderr.write(
            `  TTS attempt ${attempt}/${maxAttempts} failed (${shortMessage(err)}); retrying in ${backoffMs / 1000}s\n`,
          )
          await new Promise((r) => setTimeout(r, backoffMs))
        }
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(`OpenAI TTS failed after ${maxAttempts} attempts: ${shortMessage(lastErr)}`)
  }
}

class RetryableError extends Error {}

/**
 * undici surfaces a dropped connection as `TypeError: terminated` (often with
 * a `cause` of ECONNRESET/UND_ERR_SOCKET). Treat those — and generic fetch
 * failures — as transient and worth retrying.
 */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return true
  const msg = err.message.toLowerCase()
  if (msg.includes('terminated') || msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket')) {
    return true
  }
  const cause = (err as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code ?? ''
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(code) || isNetworkError(cause)
  }
  return false
}

export function shortMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 160)
}
