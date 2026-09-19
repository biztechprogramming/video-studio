import type { SourceItem, SourceSpec } from '../types.ts'
import {
  MAX_CONTENT_CHARS,
  domainOf,
  fetchArticleText,
  fetchJson,
  formatCount,
  htmlToText,
  relativeTime,
  truncate,
} from './text.ts'

const ALGOLIA = 'https://hn.algolia.com/api/v1'
const USER_AGENT = 'video-studio'

/** How many top-level comments make it into `content`. */
const COMMENT_LIMIT = 8
/** Characters of linked-article text to pull in, leaving room for the comments. */
const ARTICLE_CHARS = 6000

interface AlgoliaHit {
  objectID: string
  title?: string | null
  url?: string | null
  author?: string
  points?: number | null
  num_comments?: number | null
  created_at?: string
  created_at_i?: number
  story_text?: string | null
  _tags?: string[]
}

interface AlgoliaItem {
  id: number
  type?: string
  title?: string | null
  text?: string | null
  author?: string | null
  points?: number | null
  created_at?: string
  children?: AlgoliaItem[]
}

export async function fetchHackerNews(
  spec: Extract<SourceSpec, { type: 'hackernews' }>,
  count: number,
  log: (msg: string) => void,
): Promise<SourceItem[]> {
  const numericFilters: string[] = []
  if (typeof spec.points === 'number') numericFilters.push(`points>=${spec.points}`)
  if (typeof spec.days === 'number') {
    numericFilters.push(`created_at_i>${Math.floor(Date.now() / 1000) - spec.days * 86_400}`)
  }

  const params = new URLSearchParams({
    tags: spec.tags ?? 'story',
    // Over-fetch: dead/titleless stories get filtered out below.
    hitsPerPage: String(Math.min(Math.max(count * 3, 10), 50)),
  })
  if (spec.query) params.set('query', spec.query)
  if (numericFilters.length > 0) params.set('numericFilters', numericFilters.join(','))

  // search_by_date is the only endpoint that respects a hard time window;
  // plain /search would happily hand back a 2018 classic for "rust".
  const endpoint = typeof spec.days === 'number' ? 'search_by_date' : 'search'
  const url = `${ALGOLIA}/${endpoint}?${params}`
  log(`  hackernews: GET ${url}`)

  const res = await fetchJson<{ hits?: AlgoliaHit[] }>(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeoutMs: 15_000,
  })
  const hits = (res.hits ?? []).filter((h) => h.title && h.objectID)
  if (hits.length === 0) {
    throw new Error(
      `Hacker News search returned no stories (${url}). Loosen the filters: lower \`points\`, ` +
        'widen `days`, or drop `query`.',
    )
  }

  // Algolia's relevance ranking is not the same as "the best story"; for a
  // countdown video, points is the ordering the audience expects.
  hits.sort((a, b) => (b.points ?? 0) - (a.points ?? 0))

  const items: SourceItem[] = []
  for (const hit of hits.slice(0, count)) {
    items.push(await toItem(hit, log))
  }
  return items
}

async function toItem(hit: AlgoliaHit, log: (msg: string) => void): Promise<SourceItem> {
  const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`
  const url = hit.url || discussion
  const points = hit.points ?? 0
  const numComments = hit.num_comments ?? 0

  const [comments, article] = await Promise.all([
    topComments(hit.objectID, log),
    // Ask-HN/Show-HN self posts have no external link to fetch.
    hit.url ? fetchArticleText(hit.url, ARTICLE_CHARS) : Promise.resolve(''),
  ])

  const sections: string[] = []
  const selfText = hit.story_text ? htmlToText(hit.story_text) : ''
  if (selfText) sections.push(selfText)
  if (article) sections.push(`ARTICLE (${domainOf(url)}):\n${article}`)
  if (comments.length > 0) {
    sections.push(
      `TOP COMMENTS:\n${comments.map((c) => `- ${c.author}: ${c.text}`).join('\n\n')}`,
    )
  }
  if (sections.length === 0) sections.push(hit.title ?? '')

  const stats: { label: string; value: string }[] = [
    { label: 'Points', value: formatCount(points) },
    { label: 'Comments', value: formatCount(numComments) },
  ]
  const posted = relativeTime(hit.created_at ?? hit.created_at_i ?? '')
  if (posted) stats.push({ label: 'Posted', value: posted })
  const domain = domainOf(url)
  if (domain) stats.push({ label: 'Domain', value: domain })

  log(`  hackernews: ${hit.title} (${points} points, ${comments.length} comments quoted)`)

  return {
    id: hit.objectID,
    source: 'hackernews',
    name: hit.title ?? `HN item ${hit.objectID}`,
    url,
    description: `${points} points, ${numComments} comments on Hacker News${domain ? ` · ${domain}` : ''}`,
    score: points,
    stats,
    content: truncate(sections.join('\n\n'), MAX_CONTENT_CHARS),
    meta: {
      discussion,
      author: hit.author,
      domain,
      tags: hit._tags ?? [],
      articleFetched: article.length > 0,
      commentCount: comments.length,
    },
  }
}

/**
 * The top ~8 top-level comments, HTML stripped.
 *
 * Best-effort: a missing or slow thread costs us the quotes, not the item.
 * Algolia returns children in HN's own ranked order, but points are present
 * often enough to be worth sorting on when they are.
 */
async function topComments(
  objectID: string,
  log: (msg: string) => void,
): Promise<{ author: string; text: string }[]> {
  try {
    const item = await fetchJson<AlgoliaItem>(`${ALGOLIA}/items/${objectID}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeoutMs: 15_000,
    })
    const children = (item.children ?? []).filter((c) => c.text && c.author)
    const ranked = children.every((c) => typeof c.points === 'number')
      ? [...children].sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
      : children
    return ranked.slice(0, COMMENT_LIMIT).map((c) => ({
      author: c.author as string,
      // Comments run long; one paragraph each is plenty of flavour.
      text: truncate(htmlToText(c.text as string), 800),
    }))
  } catch (err) {
    log(`  hackernews: comments for ${objectID} unavailable (${(err as Error).message.slice(0, 120)})`)
    return []
  }
}
