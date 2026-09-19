// Shared plumbing for the source adapters: HTTP with timeouts, and the
// HTML/markdown → plain-prose helpers that turn a README or an article page
// into something an LLM can read aloud.
//
// Everything here is Node builtins + global fetch on purpose. A scraper that
// needs cheerio/axios is a scraper that breaks on `npm ci` six months from now.

/** Hard cap on `SourceItem.content`. Anything longer is wasted script-writer context. */
export const MAX_CONTENT_CHARS = 12_000

/** Default per-request timeout. A hung socket must never stall the pipeline. */
const DEFAULT_TIMEOUT_MS = 15_000

export interface FetchOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  /** Extra attempts after the first, for 5xx/429 only. Default 1. */
  retries?: number
  /** Passed through to fetch; 'follow' by default. */
  redirect?: RequestRedirect
}

/**
 * fetch with a timeout and one retry on 5xx/429.
 *
 * Returns the Response whatever the status — callers that need to inspect
 * rate-limit headers (github.ts) or quietly give up (fetchArticleText) do
 * their own thing with it. Only network/timeout failures throw.
 */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { headers, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, redirect = 'follow' } = opts
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { headers, redirect, signal: ac.signal })
      // 429/5xx are transient; everything else (including 403) is the caller's
      // business — retrying a rate-limit rejection just burns the quota again.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const waitMs = retryAfterMs(res) ?? 1000 * 2 ** attempt
        await sleep(waitMs)
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      const timedOut = err instanceof Error && err.name === 'AbortError'
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      throw new Error(
        timedOut
          ? `GET ${url} timed out after ${timeoutMs}ms. Check network access to that host.`
          : `GET ${url} failed: ${shortMessage(err)}`,
        { cause: err },
      )
    } finally {
      clearTimeout(timer)
    }
  }
  // Unreachable: the loop either returns or throws. Keeps TS's control flow happy.
  throw new Error(`GET ${url} failed: ${shortMessage(lastErr)}`)
}

/**
 * fetchWithRetry + JSON parsing. Non-2xx and unparseable bodies throw with the
 * URL and the start of the body, because "unexpected token <" with no context
 * is the least debuggable error there is.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts)
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
  }
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`GET ${url} returned ${res.status} but the body is not JSON: ${body.slice(0, 200)}`)
  }
}

/** fetchWithRetry for pages we parse as text/HTML. Non-2xx throws. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts)
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
  }
  return body
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  // Cap it: some hosts say "retry after 600" and we'd rather skip than hang.
  return Number.isFinite(secs) ? Math.min(Math.max(secs, 0), 10) * 1000 : undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function shortMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200)
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

/** Tags whose *contents* are chrome, not content. */
const DROP_BLOCKS = /<(script|style|noscript|svg|template|iframe|nav|header|footer|form|aside)\b[^>]*>[\s\S]*?<\/\1>/gi
/** Tags that imply a line break when removed. */
const BLOCK_TAGS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|ul|ol|table)\b[^>]*>/gi

/**
 * Strip an HTML document down to readable prose.
 *
 * Deliberately regex-based and lossy: the consumer is an LLM writing a
 * narration script, not a renderer, so "roughly the words in reading order"
 * is the whole requirement.
 */
export function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // Run the block-drop twice: nested <div><script> pairs survive one pass.
  s = s.replace(DROP_BLOCKS, ' ').replace(DROP_BLOCKS, ' ')
  s = s.replace(BLOCK_TAGS, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  return collapse(s)
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
  middot: '·', bull: '•', trade: '™', copy: '©', reg: '®', deg: '°', euro: '€',
  pound: '£', times: '×', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', uuml: 'ü',
}

/** The handful of entities that actually show up in READMEs and news articles. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+\d?);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/** Collapse runs of spaces and blank lines, trim every line. */
function collapse(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Markdown → text
// ---------------------------------------------------------------------------

/**
 * Turn a README into prose.
 *
 * READMEs open with a wall of shields.io badges, a centred logo and an HTML
 * table of contents — all of which read as noise ("build passing npm version
 * MIT license Discord") and crowd out the paragraph that actually says what
 * the project does. So badges, images and code fences go, and headings survive
 * as bare lines.
 */
export function markdownToText(md: string): string {
  let s = md.replace(/\r\n?/g, '\n')

  // Front matter, then fenced and indented-HTML blocks.
  s = s.replace(/^---\n[\s\S]*?\n---\n/, '')
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '\n')
  // Unterminated fence at EOF (truncated README): drop the tail.
  s = s.replace(/^[ \t]*(```|~~~)[\s\S]*$/m, '\n')

  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(DROP_BLOCKS, ' ').replace(DROP_BLOCKS, ' ')
  // <br> and friends are line breaks; every other tag just disappears.
  s = s.replace(/<\/?(p|div|br|li|tr|h[1-6]|table|blockquote)\b[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')

  // Images and badges: `![alt](url)`, and `[![alt](img)](link)` badge chains.
  s = s.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')

  // Links → their text. Reference definitions and anchors go entirely.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  s = s.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, '')

  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '') // headings → plain lines
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '')      // block quotes
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '- ')    // normalise bullets
  s = s.replace(/^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '') // --- rules
  s = s.replace(/^\|[ \t:|-]+\|$/gm, '')         // table separator rows
  s = s.replace(/^\|(.*)\|$/gm, (_, row: string) => row.split('|').map((c) => c.trim()).join(' — '))
  s = s.replace(/`{1,3}([^`]*)`{1,3}/g, '$1')    // inline code
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')       // bold
  s = s.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1') // italics

  s = decodeEntities(s)
  s = collapse(s)

  // Drop leftover lines that are pure punctuation/badge rubble, and the
  // bullet-only lines left behind where a badge used to be.
  return s
    .split('\n')
    .filter((line) => line === '' || /[\p{L}\p{N}]/u.test(line.replace(/^- /, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Article fetching
// ---------------------------------------------------------------------------

/** A real-looking UA: plenty of publishers 403 anything that smells scripted. */
export const ARTICLE_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 video-studio/0.1'

/**
 * Best-effort readable text for a linked article.
 *
 * Every failure mode — paywall, PDF, 404, TLS error, timeout — returns '' and
 * costs the caller nothing. The article is a bonus on top of the HN/Reddit
 * discussion, never a reason to fail the run.
 */
export async function fetchArticleText(url: string, maxChars = 6000): Promise<string> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  } catch {
    return ''
  }
  try {
    const res = await fetchWithRetry(url, {
      timeoutMs: 10_000,
      retries: 0, // a slow article isn't worth a second 10s wait
      headers: { 'User-Agent': ARTICLE_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    })
    if (!res.ok) return ''
    const type = res.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml/i.test(type)) return ''
    const html = await res.text()
    return truncate(htmlToText(extractMainHtml(html)), maxChars)
  } catch {
    return ''
  }
}

/**
 * Prefer <article>/<main> when the page has one — it skips the nav, cookie
 * banner and "related stories" rail without needing a readability port.
 */
function extractMainHtml(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)
  if (article && article[1].length > 500) return article[1]
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (main && main[1].length > 500) return main[1]
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  return body ? body[1] : html
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Cut at the last paragraph break near the limit, so the text ends cleanly. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  // Look for a break in the last 30% — anything earlier throws away too much.
  const floor = Math.floor(maxChars * 0.7)
  const candidates = [head.lastIndexOf('\n\n'), head.lastIndexOf('. '), head.lastIndexOf('\n')]
  const cut = candidates.find((i) => i >= floor) ?? -1
  return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}\n\n[…truncated]`
}

/** 482 → "482", 48234 → "48.2k", 1_240_000 → "1.2M". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return trimZero(n / 1_000_000) + 'M'
  if (abs >= 1_000) return trimZero(n / 1_000) + 'k'
  return String(Math.round(n))
}

function trimZero(v: number): string {
  return v.toFixed(1).replace(/\.0$/, '')
}

/** ISO string or epoch seconds → "3 days ago". */
export function relativeTime(when: string | number | Date): string {
  const then =
    when instanceof Date ? when.getTime()
    : typeof when === 'number' ? (when > 1e12 ? when : when * 1000) // seconds or ms
    : Date.parse(when)
  if (!Number.isFinite(then)) return ''
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 0) return 'just now' // clock skew; "in -2 seconds" helps nobody
  const units: [number, string][] = [
    [60, 'second'], [3600, 'minute'], [86_400, 'hour'], [2_592_000, 'day'],
    [31_536_000, 'month'], [Infinity, 'year'],
  ]
  const divisors: Record<string, number> = {
    second: 1, minute: 60, hour: 3600, day: 86_400, month: 2_592_000, year: 31_536_000,
  }
  for (const [limit, unit] of units) {
    if (secs < limit) {
      const n = Math.floor(secs / divisors[unit])
      if (n < 1) return 'just now'
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`
    }
  }
  return ''
}

/** "https://www.bbc.co.uk/news/x" → "bbc.co.uk". '' when unparseable. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
