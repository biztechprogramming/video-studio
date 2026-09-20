import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { gatewayDownError, openaiBaseUrl, requireOpenAIKey } from '../config.ts'
import { runFfmpeg } from './encode.ts'
import type { FootageBeat } from '../types.ts'

// Generative b-roll: the moving footage that replaced the full-frame slides.
// A segment's card is composited over this rather than cutting away to a still.
//
// Clips are content-addressed on disk, exactly like the TTS cache, because a
// generated shot is the most expensive thing in the whole pipeline — a
// re-render of an unchanged prompt must never call the API again.

// Both read the environment late, on call. This module is imported before
// `loadEnv()` runs, so anything captured at module load sees the shell only and
// silently ignores .env.
export function defaultFootageModel(): string {
  return process.env.OPENAI_VIDEO_MODEL ?? 'sora-2'
}
function apiBase(): string {
  return openaiBaseUrl(process.env.OPENAI_VIDEO_BASE_URL)
}

/** The API accepts only these clip lengths; anything else is a 400. */
const ALLOWED_SECONDS = [4, 8, 12]
/** Cost ceiling per card: at most this many generated shots back one overlay. */
const MAX_BEATS_PER_CLIP = 3
/** A queued generation can sit for a while; give up rather than hang a render. */
const POLL_TIMEOUT_MS = 12 * 60_000
const POLL_INTERVAL_MS = 5_000

/**
 * The account can't generate video at all (no access, unknown model, billing).
 * Distinct from a single shot failing: the caller stops asking for the rest of
 * the run instead of burning a timeout per segment.
 */
export class FootageUnavailableError extends Error {}

class RetryableError extends Error {}

export interface FootageRequest {
  beats: FootageBeat[]
  /** Seconds of footage the narration needs covering. */
  durationSec: number
  /** Generated frame size, "WxH". */
  size: string
  model: string
  /** Default beat length; a beat may override it. */
  beatSeconds: number
  /** Where the concatenated result is written. */
  outPath: string
  /** Content-addressed store for individual generated shots. */
  cacheDir: string
  log?: (msg: string) => void
}

/**
 * Produce one continuous piece of b-roll at least `durationSec` long.
 *
 * Beats are cycled rather than stretched: two 8-second shots covering 14
 * seconds of narration reads as a cut, which is what we want — stretching one
 * shot to fit is how footage starts feeling like a slide again. If the voice
 * outruns the beats we have, the renderer loops the result instead of paying
 * for more generation (see MAX_BEATS_PER_CLIP).
 *
 * Returns undefined when nothing could be generated, so the caller can fall
 * back to a still card rather than losing the segment.
 */
export async function buildFootage(req: FootageRequest): Promise<string | undefined> {
  const log = req.log ?? (() => {})
  const beats = req.beats.filter((b) => b?.prompt?.trim())
  if (beats.length === 0) return undefined

  const plan: FootageBeat[] = []
  let planned = 0
  while (planned < req.durationSec && plan.length < MAX_BEATS_PER_CLIP) {
    const beat = beats[plan.length % beats.length]
    // Generated seconds are the most expensive thing in the pipeline, so the
    // last beat is shortened to what's actually left rather than always
    // costing a full one: a 17-second slot buys 8 + 8 + 4, not 8 + 8 + 8.
    // Rounding *up* to a length the API accepts matters — rounding to nearest
    // leaves a sliver uncovered and buys a whole extra shot to cover it.
    const remaining = req.durationSec - planned
    const seconds = Math.min(normalizeSeconds(beat.seconds ?? req.beatSeconds), ceilSeconds(remaining))
    plan.push({ prompt: beat.prompt.trim(), seconds })
    planned += seconds
  }

  await fs.mkdir(req.cacheDir, { recursive: true })
  const parts: string[] = []
  for (const [i, beat] of plan.entries()) {
    const key = cacheKey({ model: req.model, size: req.size, seconds: beat.seconds!, prompt: beat.prompt })
    const path = join(req.cacheDir, `${key}.mp4`)
    if (await exists(path)) {
      log(`    shot ${i + 1}/${plan.length}: cached`)
      parts.push(path)
      continue
    }
    try {
      log(`    shot ${i + 1}/${plan.length}: generating ${beat.seconds}s with ${req.model}...`)
      await generateShot({ ...beat, seconds: beat.seconds!, model: req.model, size: req.size, outPath: path, log })
      parts.push(path)
    } catch (err) {
      // Half-written files must never look like a cache hit next time.
      await fs.rm(path, { force: true }).catch(() => {})
      if (err instanceof FootageUnavailableError) throw err
      // One rejected prompt (moderation, a transient 500) shouldn't cost the
      // whole segment — keep whatever else generated and move on.
      log(`    WARNING: shot ${i + 1} failed (${short(err)}); continuing without it`)
    }
  }

  if (parts.length === 0) return undefined
  if (parts.length === 1) {
    await fs.mkdir(dirname(req.outPath), { recursive: true })
    await fs.copyFile(parts[0], req.outPath)
    return req.outPath
  }
  await concatFootage(parts, req.size, req.outPath)
  return req.outPath
}

/** Create → poll → download one generated clip. */
async function generateShot(opts: {
  prompt: string
  seconds: number
  model: string
  size: string
  outPath: string
  log: (msg: string) => void
}): Promise<void> {
  // A key that isn't there won't be there for the next shot either: raise the
  // whole-run signal so the renderer stops asking after the first segment.
  const apiKey = await requireOpenAIKey(apiBase()).catch((err: unknown) => {
    throw new FootageUnavailableError(err instanceof Error ? err.message : String(err))
  })
  const auth = { Authorization: `Bearer ${apiKey}` }

  const created = await withRetries(() =>
    apiJson<{ id?: string; status?: string; error?: { message?: string } }>(`${apiBase()}/videos`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        // The API wants these as strings, not numbers.
        seconds: String(opts.seconds),
        size: opts.size,
      }),
    }),
  )
  const id = created.id
  if (!id) throw new Error(`Video API returned no job id: ${JSON.stringify(created).slice(0, 200)}`)

  const deadline = Date.now() + POLL_TIMEOUT_MS
  let status = created.status ?? 'queued'
  let lastLogged = -1
  while (status !== 'completed') {
    if (Date.now() > deadline) throw new Error(`Generation timed out after ${POLL_TIMEOUT_MS / 60_000} minutes`)
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const job = await withRetries(() =>
      apiJson<{ status?: string; progress?: number; error?: { message?: string } }>(`${apiBase()}/videos/${id}`, {
        headers: auth,
      }),
    )
    status = job.status ?? status
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(job.error?.message ?? `Generation ${status}`)
    }
    const pct = Math.round(job.progress ?? 0)
    if (pct >= lastLogged + 25) {
      opts.log(`      ${pct}%`)
      lastLogged = pct
    }
  }

  const bytes = await withRetries(async () => {
    const res = await apiFetch(`${apiBase()}/videos/${id}/content`, { headers: auth })
    return Buffer.from(await res.arrayBuffer())
  })
  if (bytes.length === 0) throw new Error('Video API returned an empty file')
  await fs.mkdir(dirname(opts.outPath), { recursive: true })
  await fs.writeFile(opts.outPath, bytes)
}

/**
 * Join generated shots into one piece of b-roll.
 *
 * Deliberately not `concatClips`: generated clips carry their own synthesized
 * audio, which we always throw away (the episode's sound is narration plus the
 * music bed), and a video-only concat can't go down the audio-mapping path.
 */
async function concatFootage(parts: string[], size: string, outPath: string): Promise<void> {
  const [w, h] = size.split('x').map(Number)
  await fs.mkdir(dirname(outPath), { recursive: true })
  const scale = parts
    .map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[v${i}];`)
    .join('')
  const chain = parts.map((_, i) => `[v${i}]`).join('')
  await runFfmpeg([
    '-y',
    ...parts.flatMap((p) => ['-i', p]),
    '-filter_complex', `${scale}${chain}concat=n=${parts.length}:v=1:a=0[v]`,
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    outPath,
  ])
}

/** Round a requested length to the nearest length the API will accept. */
export function normalizeSeconds(seconds: number): number {
  return ALLOWED_SECONDS.reduce((best, s) => (Math.abs(s - seconds) < Math.abs(best - seconds) ? s : best), ALLOWED_SECONDS[0])
}

/** The shortest acceptable length that still covers `seconds`. */
function ceilSeconds(seconds: number): number {
  return ALLOWED_SECONDS.find((s) => s >= seconds) ?? ALLOWED_SECONDS[ALLOWED_SECONDS.length - 1]
}

/**
 * The generated frame size for a delivered frame. The video models offer a
 * fixed menu of sizes, none of which is 1920x1080, so we generate at the
 * matching orientation and let the compositor scale up — b-roll sitting under
 * a title card is the one thing in the episode that can afford it.
 */
export function defaultFootageSize(width: number, height: number): string {
  return height > width ? '720x1280' : '1280x720'
}

function cacheKey(o: { model: string; size: string; seconds: number; prompt: string }): string {
  return createHash('sha256').update(`${o.model} ${o.size} ${o.seconds} ${o.prompt}`).digest('hex').slice(0, 32)
}

async function apiJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await apiFetch(url, init)
  return (await res.json()) as T
}

/**
 * One request, with the 4xx/5xx split the rest of the project uses: a bad key
 * or a model this account can't reach is fatal and specific; 429/5xx is
 * transient and retried by the caller.
 */
async function apiFetch(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 120_000)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal }).catch((err: unknown) => {
      // Unreachable gateway stops the whole run rather than one shot: every
      // later segment would fail the same way.
      const down = gatewayDownError(apiBase(), err)
      throw down ? new FootageUnavailableError(down.message) : err
    })
    if (res.ok) return res
    const text = await res.text()
    const error = parseError(text)
    if (res.status === 404 || res.status === 403 || error?.code === 'model_not_found' || error?.param === 'model') {
      throw new FootageUnavailableError(
        `The video model "${JSON.parse(String(init.body ?? '{}')).model ?? 'unknown'}" isn't available to this key: ` +
        `${error?.message ?? text.slice(0, 200)}\n` +
        `  Set OPENAI_VIDEO_MODEL in .env, or render with --no-footage.`,
      )
    }
    if (res.status < 500 && res.status !== 429) throw new Error(`Video API ${res.status}: ${error?.message ?? text.slice(0, 300)}`)
    throw new RetryableError(`Video API ${res.status}: ${text.slice(0, 200)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 4
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (err instanceof FootageUnavailableError) throw err
      const retryable = err instanceof RetryableError || isNetworkError(err)
      if (!retryable || attempt === maxAttempts) throw err
      const backoff = 1500 * 2 ** (attempt - 1)
      process.stderr.write(`      video API attempt ${attempt}/${maxAttempts} failed; retrying in ${backoff / 1000}s\n`)
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

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

function parseError(text: string): { message?: string; code?: string; param?: string } | undefined {
  try {
    return JSON.parse(text).error
  } catch {
    return undefined
  }
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 140)
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).size > 0
  } catch {
    return false
  }
}
