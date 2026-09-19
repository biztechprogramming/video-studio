import type { SourceItem, SourceSpec } from '../types.ts'
import {
  MAX_CONTENT_CHARS,
  domainOf,
  fetchArticleText,
  fetchJson,
  formatCount,
  markdownToText,
  relativeTime,
  truncate,
} from './text.ts'

/**
 * Reddit 403s anything that looks like a generic script ("Mozilla/5.0" alone
 * included), so identify the tool properly — that is also what their API terms
 * ask for. Some hosts/IP ranges are blocked outright regardless of UA; see the
 * per-subreddit handling below.
 */
const USER_AGENT = 'linux:video-studio:0.1.0 (research bot for a narrated-video pipeline)'

/** Reddit's page size. We over-fetch and rank across subreddits ourselves. */
const PER_SUB_LIMIT = 25
const ARTICLE_CHARS = 6000

interface RedditPost {
  id: string
  name?: string
  title: string
  permalink: string
  url?: string
  subreddit: string
  author?: string
  score?: number
  num_comments?: number
  created_utc?: number
  selftext?: string
  is_self?: boolean
  stickied?: boolean
  over_18?: boolean
  post_hint?: string
  thumbnail?: string
  link_flair_text?: string | null
}

interface RedditListing {
  data?: { children?: { data: RedditPost }[] }
}

export async function fetchReddit(
  spec: Extract<SourceSpec, { type: 'reddit' }>,
  count: number,
  log: (msg: string) => void,
): Promise<SourceItem[]> {
  if (spec.subreddits.length === 0) {
    throw new Error('reddit source needs at least one entry in `subreddits`.')
  }
  const sort = spec.sort ?? 'hot'
  const time = spec.time ?? 'day'

  const posts: RedditPost[] = []
  const failed: string[] = []

  for (const raw of spec.subreddits) {
    const sub = raw.replace(/^\/?r\//, '').trim()
    const params = new URLSearchParams({ limit: String(PER_SUB_LIMIT) })
    // `t` only means anything for /top, but sending it always is harmless.
    if (sort === 'top') params.set('t', time)
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}.json?${params}`
    try {
      const listing = await fetchJson<RedditListing>(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeoutMs: 15_000,
      })
      const children = listing.data?.children ?? []
      // Stickied mod posts and NSFW threads make bad video segments.
      const usable = children
        .map((c) => c.data)
        .filter((p) => p && p.title && !p.stickied && !p.over_18)
      if (usable.length === 0) {
        log(`  reddit: r/${sub} returned nothing usable (private, empty, or all stickied) — skipped`)
        failed.push(sub)
        continue
      }
      posts.push(...usable)
      log(`  reddit: r/${sub} → ${usable.length} posts`)
    } catch (err) {
      // One blocked or renamed subreddit must not sink an episode that has
      // four more to draw on. Warn loudly, keep going.
      log(`  reddit: WARNING r/${sub} skipped — ${explain(err)}`)
      failed.push(sub)
    }
  }

  if (posts.length === 0) {
    throw new Error(
      `Reddit returned no posts for any of: ${failed.map((s) => `r/${s}`).join(', ')}. ` +
        'If these are 403s, Reddit is blocking this host/IP for unauthenticated JSON reads — ' +
        'try again from another network, or switch this query to a different source.',
    )
  }

  // Score is the only cross-subreddit ranking we have.
  posts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const items: SourceItem[] = []
  for (const post of posts.slice(0, count)) {
    items.push(await toItem(post))
  }
  for (const item of items) log(`  reddit: ${item.name} (${formatCount(item.score ?? 0)} upvotes)`)
  return items
}

/**
 * A one-line reason. Reddit's 403 body is a full HTML block page, so match the
 * status and say what it means instead of pasting 200 characters of CSS.
 */
function explain(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  if (/→ HTTP 403/.test(msg)) return 'HTTP 403 — Reddit is blocking unauthenticated JSON from this host/IP'
  if (/→ HTTP 429/.test(msg)) return 'HTTP 429 — rate limited'
  if (/→ HTTP 404/.test(msg)) return 'HTTP 404 — no such subreddit'
  if (/→ HTTP 451/.test(msg)) return 'HTTP 451 — quarantined or region-blocked'
  if (/→ HTTP (\d+)/.test(msg)) return msg.replace(/^GET \S+ → /, '').slice(0, 160)
  return msg.slice(0, 160)
}

async function toItem(post: RedditPost): Promise<SourceItem> {
  const discussion = `https://www.reddit.com${post.permalink}`
  // Self posts point at their own thread; link posts at the article.
  const external = post.url && !post.is_self && !post.url.includes('reddit.com') ? post.url : ''
  const url = external || discussion

  // `selftext` is raw markdown (`selftext_html` is the rendered form), so it
  // needs the same de-badging/de-formatting pass a README gets.
  const selfText = post.selftext ? markdownToText(post.selftext) : ''
  const article = external ? await fetchArticleText(external, ARTICLE_CHARS) : ''

  const sections: string[] = []
  if (selfText) sections.push(selfText)
  if (article) sections.push(`ARTICLE (${domainOf(external)}):\n${article}`)
  if (sections.length === 0) sections.push(post.title)

  const stats: { label: string; value: string }[] = [
    { label: 'Upvotes', value: formatCount(post.score ?? 0) },
    { label: 'Comments', value: formatCount(post.num_comments ?? 0) },
    { label: 'Subreddit', value: `r/${post.subreddit}` },
  ]
  const posted = post.created_utc ? relativeTime(post.created_utc) : ''
  if (posted) stats.push({ label: 'Posted', value: posted })

  return {
    id: post.name ?? `t3_${post.id}`,
    source: 'reddit',
    name: post.title,
    url,
    description: `r/${post.subreddit} · ${formatCount(post.score ?? 0)} upvotes, ${formatCount(post.num_comments ?? 0)} comments`,
    score: post.score,
    stats,
    content: truncate(sections.join('\n\n'), MAX_CONTENT_CHARS),
    meta: {
      discussion,
      subreddit: post.subreddit,
      author: post.author,
      flair: post.link_flair_text ?? undefined,
      domain: domainOf(url),
      isSelf: !!post.is_self,
      articleFetched: article.length > 0,
      thumbnail: post.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : undefined,
    },
  }
}
