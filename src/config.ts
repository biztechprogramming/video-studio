import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as readline from 'node:readline/promises'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ENV_PATH = join(PROJECT_ROOT, '.env')
export const EPISODES_DIR = join(PROJECT_ROOT, 'episodes')
export const QUERIES_DIR = join(PROJECT_ROOT, 'queries')
export const TEMPLATES_DIR = join(PROJECT_ROOT, 'templates')

/**
 * Load the project's .env regardless of which directory the CLI was invoked
 * from. Values already in the environment win, so a shell override still
 * works. Missing .env is fine — the keys may come from the shell.
 */
export function loadEnv(): void {
  try {
    process.loadEnvFile(ENV_PATH)
  } catch {
    /* no .env — requireEnv() will prompt for whatever is actually needed */
  }
}

/** Video presets. 16:9 for normal uploads, 9:16 for Shorts. */
export const PRESETS = {
  landscape: { width: 1920, height: 1080, fps: 30 },
  shorts: { width: 1080, height: 1920, fps: 30 },
} as const

export type PresetName = keyof typeof PRESETS

export function resolveVideo(v?: {
  preset?: PresetName
  width?: number
  height?: number
  fps?: number
}): { width: number; height: number; fps: number } {
  const base = PRESETS[v?.preset ?? 'landscape']
  return {
    width: v?.width ?? base.width,
    height: v?.height ?? base.height,
    fps: v?.fps ?? base.fps,
  }
}

/**
 * Fetch a required setting. If it isn't in the environment, ask for it and
 * write the answer to .env so it's only ever asked once — a run must never
 * die three minutes in because a key the user could have typed was missing.
 * Non-interactive (cron, CI) runs still fail fast, with the fix spelled out.
 */
export async function requireEnv(name: string, opts: { hint: string; example?: string }): Promise<string> {
  const existing = process.env[name]
  if (existing && existing.trim()) return existing.trim()

  if (!process.stdin.isTTY) {
    throw new Error(
      `${name} is not set and there's no terminal to ask on.\n` +
      `  ${opts.hint}\n` +
      `  Fix: add ${name}=... to ${ENV_PATH}`,
    )
  }

  process.stderr.write(`\n${name} is not set. ${opts.hint}\n`)
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = (await rl.question(`${name}${opts.example ? ` (e.g. ${opts.example})` : ''}: `)).trim()
  rl.close()
  if (!answer) throw new Error(`${name} is required.`)

  process.env[name] = answer
  await appendEnv(name, answer)
  process.stderr.write(`Saved ${name} to ${ENV_PATH}\n\n`)
  return answer
}

/** Append (or replace) a key in .env, keeping the file mode private. */
export async function appendEnv(name: string, value: string): Promise<void> {
  let body = ''
  try {
    body = await fs.readFile(ENV_PATH, 'utf8')
  } catch {
    /* first key */
  }
  const line = `${name}=${value}`
  const re = new RegExp(`^${name}=.*$`, 'm')
  body = re.test(body) ? body.replace(re, line) : `${body.replace(/\n*$/, '\n')}${line}\n`
  await fs.writeFile(ENV_PATH, body.replace(/^\n+/, ''), { mode: 0o600 })
}

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * Where OpenAI-shaped requests go. `OPENAI_BASE_URL` points the whole pipeline
 * at something else — a local gateway, LiteLLM, a self-hosted model — and each
 * caller can pass a narrower override (`OPENAI_VIDEO_BASE_URL`) so one stage
 * moves without dragging the other two with it. That matters because the
 * stages aren't interchangeable: a subscription-backed gateway can write a
 * script, but nothing outside the metered API will speak it or generate b-roll.
 */
export function openaiBaseUrl(override?: string): string {
  const raw = override?.trim() || process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL
  return raw.replace(/\/+$/, '')
}

/** True when `base` is OpenAI itself, and the key therefore has to be real. */
function isOpenAIHosted(base: string): boolean {
  try {
    return new URL(base).host === 'api.openai.com'
  } catch {
    return false
  }
}

/**
 * Sent as the bearer when the endpoint isn't OpenAI and no key is set. A
 * gateway holds its own upstream credentials, and a subscription-backed
 * backend has no key at all — but most still want a non-empty Authorization
 * header, so send something recognisable rather than nothing.
 */
const GATEWAY_KEY = 'unused'

const OPENAI_KEY_PROMPT = {
  hint: 'Used to write the narration script, synthesize the voice, and generate the b-roll. Create one at https://platform.openai.com/api-keys',
  example: 'sk-proj-...',
}

/** The key as it stands, without prompting. Empty when there genuinely isn't one. */
export function openaiKey(base: string): string {
  const existing = process.env.OPENAI_API_KEY?.trim()
  if (existing) return existing
  return isOpenAIHosted(base) ? '' : GATEWAY_KEY
}

/** As `openaiKey`, but asks for a missing one rather than failing the run. */
export async function requireOpenAIKey(base: string): Promise<string> {
  return openaiKey(base) || (await requireEnv('OPENAI_API_KEY', OPENAI_KEY_PROMPT))
}

/**
 * Turn "fetch failed" against a custom endpoint into the message that fixes
 * it. The gateway is started by hand, so a dead socket is the single most
 * likely failure of a configured run — and a bare TypeError three minutes into
 * an episode gives no clue that a background process simply isn't up.
 *
 * Returns undefined when the endpoint is OpenAI itself (where a connection
 * failure means the internet is down, not that you forgot something) or when
 * the error isn't a connection failure at all.
 */
export function gatewayDownError(base: string, err: unknown): Error | undefined {
  if (isOpenAIHosted(base)) return undefined
  const codes: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = (cur as NodeJS.ErrnoException).code
    if (code) codes.push(code)
    cur = (cur as { cause?: unknown }).cause
  }
  const refused = codes.find((c) => c === 'ECONNREFUSED' || c === 'ENOTFOUND' || c === 'EAI_AGAIN')
  if (!refused) return undefined
  return new Error(
    `Nothing is listening at ${base} (${refused}).\n` +
    `  OPENAI_BASE_URL points every stage at the local gateway, which you start by hand.\n` +
    `  Fix: run ./bin/llm-gateway in another terminal.\n` +
    `  Or:  prefix this command with OPENAI_BASE_URL= to bypass the gateway and use OpenAI directly.`,
  )
}

/** Per-episode working directory: research, script, clips, final MP4. */
export function episodeDir(slug: string): string {
  return join(EPISODES_DIR, slug)
}

export function episodePaths(slug: string) {
  const dir = episodeDir(slug)
  return {
    dir,
    research: join(dir, 'research.json'),
    script: join(dir, 'script.yaml'),
    cards: join(dir, 'cards'),
    clips: join(dir, 'clips'),
    audio: join(dir, 'audio'),
    footage: join(dir, 'footage'),
    ttsCache: join(dir, '.tts-cache'),
    footageCache: join(dir, '.footage-cache'),
    video: join(dir, `${slug}.mp4`),
    thumbnail: join(dir, 'thumbnail.png'),
    published: join(dir, 'published.json'),
  }
}

/** yyyy-mm-dd in the local timezone — used for episode slugs and titles. */
export function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}
