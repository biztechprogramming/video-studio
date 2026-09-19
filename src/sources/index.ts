// The research stage: a SourceSpec in, the subjects of the episode out.
//
// Every adapter returns fully-populated SourceItems — formatted `stats` for
// the card template, and `content` as the long text the script writer reads —
// so nothing downstream has to know where an item came from.

import type { FetchOpts, SourceItem } from '../types.ts'
import { fetchRepos, fetchSearch, fetchTrending } from './github.ts'
import { fetchHackerNews } from './hackernews.ts'
import { fetchReddit } from './reddit.ts'

export async function fetchItems(opts: FetchOpts): Promise<SourceItem[]> {
  const { spec, log } = opts
  const count = Math.max(1, Math.floor(opts.count))

  const items = await dispatch(opts, count)
  if (items.length === 0) {
    throw new Error(
      `Source "${spec.type}" returned no items. Widen the query (fewer filters, a longer time ` +
        'window) or pick a different source.',
    )
  }
  if (items.length < count) {
    log(`  ${spec.type}: only ${items.length} of ${count} requested items available`)
  }
  return items.slice(0, count)
}

function dispatch(opts: FetchOpts, count: number): Promise<SourceItem[]> {
  const { spec, log } = opts
  switch (spec.type) {
    case 'github_trending':
      return fetchTrending(spec, count, log)
    case 'github_search':
      return fetchSearch(spec, count, log)
    case 'github_repos':
      return fetchRepos(spec, count, log)
    case 'hackernews':
      return fetchHackerNews(spec, count, log)
    case 'reddit':
      return fetchReddit(spec, count, log)
    default: {
      // Exhaustiveness check: adding a SourceSpec variant without an adapter
      // becomes a compile error here rather than a runtime surprise.
      const unknown: never = spec
      throw new Error(
        `Unknown source type ${JSON.stringify((unknown as { type?: string }).type)}. Valid types: ` +
          'github_trending, github_search, github_repos, hackernews, reddit.',
      )
    }
  }
}

export { fetchRepos, fetchSearch, fetchTrending } from './github.ts'
export { fetchHackerNews } from './hackernews.ts'
export { fetchReddit } from './reddit.ts'
