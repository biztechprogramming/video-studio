import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SourceItem, SourceSpec } from '../types.ts'
import {
  MAX_CONTENT_CHARS,
  decodeEntities,
  fetchText,
  fetchWithRetry,
  formatCount,
  markdownToText,
  relativeTime,
  truncate,
} from './text.ts'

const execFileAsync = promisify(execFile)

const API = 'https://api.github.com'
const USER_AGENT = 'video-studio'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Resolved once per process: env var → `gh auth token` → unauthenticated.
 *
 * The memoised promise matters — enriching 10 repos is ~21 requests and we are
 * not spawning `gh` 21 times.
 */
let tokenPromise: Promise<string | undefined> | undefined

async function githubToken(log: (msg: string) => void): Promise<string | undefined> {
  tokenPromise ??= (async () => {
    const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (fromEnv) return fromEnv.trim()
    try {
      // The user is normally logged in with the gh CLI, so borrow its token
      // rather than making them paste one into a .env file.
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000 })
      const token = stdout.trim()
      if (token) return token
    } catch {
      // gh missing or logged out — fall through to unauthenticated.
    }
    log(
      '  WARNING: no GitHub token (GITHUB_TOKEN/GH_TOKEN unset, `gh auth token` unavailable). ' +
        'Unauthenticated requests are limited to 60/hour — run `gh auth login` or set GITHUB_TOKEN.',
    )
    return undefined
  })()
  return tokenPromise
}

async function githubHeaders(accept: string, log: (msg: string) => void): Promise<Record<string, string>> {
  const token = await githubToken(log)
  return {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/**
 * GET against api.github.com. Returns `undefined` for 404 (repo renamed,
 * deleted, or simply has no README) so callers can degrade instead of dying.
 */
async function githubApi<T>(
  path: string,
  accept: string,
  log: (msg: string) => void,
): Promise<T | undefined> {
  const url = path.startsWith('http') ? path : `${API}${path}`
  const res = await fetchWithRetry(url, { headers: await githubHeaders(accept, log), timeoutMs: 20_000 })
  if (res.status === 404) return undefined
  if (!res.ok) {
    const body = await res.text()
    throw await githubError(url, res, body, log)
  }
  const body = await res.text()
  if (accept.includes('json')) {
    try {
      return JSON.parse(body) as T
    } catch {
      throw new Error(`GET ${url} returned ${res.status} but the body is not JSON: ${body.slice(0, 200)}`)
    }
  }
  return body as unknown as T
}

/** Turn a GitHub failure into something that says what to do about it. */
async function githubError(url: string, res: Response, body: string, log: (msg: string) => void): Promise<Error> {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  const isRateLimited = (res.status === 403 || res.status === 429) && (remaining === '0' || !!res.headers.get('retry-after'))
  if (isRateLimited) {
    const resetAt = reset ? new Date(Number(reset) * 1000) : undefined
    const when = resetAt
      ? `${resetAt.toLocaleTimeString()} (in ${Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 60_000))} min)`
      : 'shortly'
    const authed = !!(await githubToken(log))
    return new Error(
      `GitHub rate limit hit on ${url}. The limit resets at ${when}. ` +
        (authed
          ? 'Your token is authenticated (5000/hour) — wait for the reset or narrow the query.'
          : 'You are unauthenticated (60/hour) — set GITHUB_TOKEN=<token> or run `gh auth login`, then re-run.'),
    )
  }
  if (res.status === 401) {
    return new Error(
      `GitHub rejected the credentials on ${url} (401). The token in GITHUB_TOKEN/GH_TOKEN (or from ` +
        '`gh auth token`) is expired or revoked — run `gh auth login` to refresh it.',
    )
  }
  return new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
}

// ---------------------------------------------------------------------------
// The repo shape we use off the REST API
// ---------------------------------------------------------------------------

interface ApiRepo {
  full_name: string
  html_url: string
  description: string | null
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  pushed_at: string
  created_at: string
  homepage: string | null
  archived: boolean
  topics?: string[]
  license?: { spdx_id?: string | null; name?: string | null } | null
  owner?: { login: string; avatar_url?: string } | null
}

/** What the trending page told us, before the API fills in the rest. */
interface TrendingRow {
  fullName: string
  description: string
  language?: string
  stars?: number
  /** Stars gained in the window. */
  delta?: number
  /** "today" | "this week" | "this month", straight from the page. */
  deltaWindow?: string
}

// ---------------------------------------------------------------------------
// github.com/trending scraping
// ---------------------------------------------------------------------------

/**
 * There is no API for the trending page, so we parse the HTML.
 *
 * Deliberately regex-per-field over each `<article class="Box-row">` block
 * rather than one giant pattern: when GitHub reshuffles the markup we lose one
 * field, not the whole page, and `parseTrending` can say exactly what it lost.
 */
export function parseTrending(html: string, pageUrl: string): TrendingRow[] {
  const blocks = html.match(/<article class="Box-row">[\s\S]*?<\/article>/g) ?? []
  if (blocks.length === 0) {
    throw new Error(
      `${pageUrl} returned no '<article class="Box-row">' blocks (${html.length} bytes). ` +
        'Either the trending page markup changed and src/sources/github.ts needs updating, or the ' +
        'request was served a login/challenge page.',
    )
  }

  const rows: TrendingRow[] = []
  for (const block of blocks) {
    // <h2 class="h3 lh-condensed"><a ... href="/owner/name">
    const href = /<h2 class="h3 lh-condensed">[\s\S]*?<a\b[^>]*\bhref="\/([^"/]+)\/([^"/?#]+)"/.exec(block)
    if (!href) continue
    const fullName = `${href[1]}/${href[2]}`

    const desc = /<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block)
    const language = /itemprop="programmingLanguage">([^<]+)</.exec(block)
    // The stargazers link carries the total; the forks link is the same shape.
    const stars = new RegExp(`href="/${escapeRe(fullName)}/stargazers"[\\s\\S]*?</svg>\\s*([\\d,]+)`).exec(block)
    const delta = /([\d,]+)\s+stars?\s+(today|this week|this month)/.exec(block)

    rows.push({
      fullName,
      description: desc ? decodeEntities(desc[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '',
      language: language?.[1].trim(),
      stars: stars ? Number(stars[1].replace(/,/g, '')) : undefined,
      delta: delta ? Number(delta[1].replace(/,/g, '')) : undefined,
      deltaWindow: delta?.[2],
    })
  }

  if (rows.length === 0) {
    throw new Error(
      `${pageUrl} had ${blocks.length} repo blocks but none matched the expected ` +
        '`<h2 class="h3 lh-condensed"><a href="/owner/name">` shape. GitHub changed the trending markup — ' +
        'update parseTrending() in src/sources/github.ts.',
    )
  }
  return rows
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trendingUrl(spec: Extract<SourceSpec, { type: 'github_trending' }>): string {
  const path = spec.language ? `/trending/${encodeURIComponent(spec.language)}` : '/trending'
  const params = new URLSearchParams({ since: spec.since ?? 'daily' })
  if (spec.spoken_language) params.set('spoken_language_code', spec.spoken_language)
  return `https://github.com${path}?${params}`
}

// ---------------------------------------------------------------------------
// Enrichment — the one path every github_* spec funnels through
// ---------------------------------------------------------------------------

async function enrich(
  fullName: string,
  source: string,
  log: (msg: string) => void,
  trending?: TrendingRow,
): Promise<SourceItem | undefined> {
  const [owner, name] = fullName.split('/')
  const repo = await githubApi<ApiRepo>(`/repos/${owner}/${name}`, 'application/vnd.github+json', log)

  if (!repo && !trending) {
    log(`  ${source}: ${fullName} not found (renamed or private?) — skipped`)
    return undefined
  }
  if (!repo) {
    // Trending listed it but the API 404s (rename in flight). Ship what we scraped.
    log(`  ${source}: ${fullName} (API 404 — using trending page data only)`)
  }

  // README first, HTML description as the fallback when there isn't one.
  const readme = await githubApi<string>(`/repos/${owner}/${name}/readme`, 'application/vnd.github.raw', log).catch(
    (err: unknown) => {
      log(`  ${source}: ${fullName} README unavailable (${(err as Error).message.slice(0, 120)})`)
      return undefined
    },
  )
  const description = repo?.description ?? trending?.description ?? ''
  const prose = readme ? markdownToText(readme) : ''
  const content = truncate(prose.length > 40 ? prose : description, MAX_CONTENT_CHARS)

  const stars = repo?.stargazers_count ?? trending?.stars
  const language = repo?.language ?? trending?.language ?? undefined
  const license = repo?.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
    ? repo.license.spdx_id
    : repo?.license?.name ?? undefined

  // Only fields the API actually returned get a chip — "License: undefined"
  // on a 4K card looks like a bug, because it is one.
  const stats: { label: string; value: string }[] = []
  if (typeof stars === 'number') stats.push({ label: 'Stars', value: formatCount(stars) })
  if (trending?.delta) {
    stats.push({ label: `Stars ${trending.deltaWindow ?? 'today'}`, value: `+${formatCount(trending.delta)}` })
  }
  if (language) stats.push({ label: 'Language', value: language })
  if (typeof repo?.forks_count === 'number') stats.push({ label: 'Forks', value: formatCount(repo.forks_count) })
  if (license) stats.push({ label: 'License', value: license })
  if (repo?.pushed_at) stats.push({ label: 'Updated', value: relativeTime(repo.pushed_at) })

  const delta = trending?.delta
  log(`  ${source}: ${fullName}${delta ? ` (+${delta} ${trending?.deltaWindow ?? 'today'})` : ''}`)

  return {
    id: fullName,
    source,
    name: fullName,
    url: repo?.html_url ?? `https://github.com/${fullName}`,
    description,
    language,
    score: stars,
    scoreDelta: delta,
    stats,
    content,
    meta: {
      owner,
      repo: name,
      topics: repo?.topics ?? [],
      homepage: repo?.homepage || undefined,
      avatar: repo?.owner?.avatar_url,
      openIssues: repo?.open_issues_count,
      archived: repo?.archived,
      createdAt: repo?.created_at,
      pushedAt: repo?.pushed_at,
      hasReadme: !!readme,
    },
  }
}

/** Enrich sequentially: it keeps the progress log in rank order and is kind to the rate limit. */
async function enrichAll(
  names: string[],
  source: string,
  log: (msg: string) => void,
  trendingByName?: Map<string, TrendingRow>,
): Promise<SourceItem[]> {
  const items: SourceItem[] = []
  for (const fullName of names) {
    const item = await enrich(fullName, source, log, trendingByName?.get(fullName))
    if (item) items.push(item)
  }
  return items
}

// ---------------------------------------------------------------------------
// Public entry points (one per github_* spec)
// ---------------------------------------------------------------------------

export async function fetchTrending(
  spec: Extract<SourceSpec, { type: 'github_trending' }>,
  count: number,
  log: (msg: string) => void,
): Promise<SourceItem[]> {
  const url = trendingUrl(spec)
  log(`  github_trending: GET ${url}`)
  const html = await fetchText(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    timeoutMs: 20_000,
  })
  const rows = parseTrending(html, url)
  // The page is already ranked, so "best first" is just page order.
  const wanted = rows.slice(0, count)
  return enrichAll(
    wanted.map((r) => r.fullName),
    'github_trending',
    log,
    new Map(wanted.map((r) => [r.fullName, r])),
  )
}

export async function fetchSearch(
  spec: Extract<SourceSpec, { type: 'github_search' }>,
  count: number,
  log: (msg: string) => void,
): Promise<SourceItem[]> {
  // The query is passed through verbatim (only URL-encoded) — qualifiers like
  // `stars:>1000 language:rust pushed:>2025-01-01` are the user's business.
  const params = new URLSearchParams({ q: spec.query, per_page: String(Math.min(Math.max(count, 1), 100)) })
  if (spec.sort) params.set('sort', spec.sort)
  if (spec.order) params.set('order', spec.order)
  const url = `${API}/search/repositories?${params}`
  log(`  github_search: ${spec.query}`)
  const result = await githubApi<{ total_count: number; items: ApiRepo[] }>(
    url,
    'application/vnd.github+json',
    log,
  )
  if (!result || result.items.length === 0) {
    throw new Error(
      `GitHub search returned no repositories for q="${spec.query}". ` +
        'Check the query syntax at https://docs.github.com/search-github/searching-on-github/searching-for-repositories.',
    )
  }
  return enrichAll(result.items.slice(0, count).map((r) => r.full_name), 'github_search', log)
}

export async function fetchRepos(
  spec: Extract<SourceSpec, { type: 'github_repos' }>,
  count: number,
  log: (msg: string) => void,
): Promise<SourceItem[]> {
  const bad = spec.repos.filter((r) => !/^[^/\s]+\/[^/\s]+$/.test(r.trim()))
  if (bad.length > 0) {
    throw new Error(`github_repos entries must be "owner/name"; got: ${bad.join(', ')}`)
  }
  return enrichAll(spec.repos.map((r) => r.trim()).slice(0, count), 'github_repos', log)
}
