import { Command } from 'commander'
import { promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { EPISODES_DIR, QUERIES_DIR, episodePaths, loadEnv, resolveVideo, slugify, today } from './config.ts'
import { fetchItems } from './sources/index.ts'
import { writeEpisode } from './script/writer.ts'
import { renderEpisode, formatTimestamp } from './render/index.ts'
import { authenticate, uploadToYouTube } from './publish/youtube.ts'
import type { Episode, QueryDef, SourceItem, SourceSpec } from './types.ts'

loadEnv()

const log = (msg: string): void => {
  process.stderr.write(msg + '\n')
}

const program = new Command()
program
  .name('video-studio')
  .description('Turn a query (GitHub trending, a GitHub search, Hacker News, Reddit) into a narrated YouTube video.')
  .version('0.1.0')

// Flags shared by `research` and `make`, so an ad-hoc episode never needs a
// saved query file first.
function addQueryOptions(cmd: Command): Command {
  return cmd
    .option('-q, --query <name>', 'Saved query from queries/<name>.yaml')
    .option('--trending [language]', 'GitHub trending, optionally for one language (e.g. --trending rust)')
    .option('--since <window>', 'Trending window: daily | weekly | monthly', 'daily')
    .option('--search <q>', 'GitHub search query, e.g. "topic:mcp stars:>500 pushed:>2026-09-01"')
    .option('--repos <list>', 'Explicit repos, comma-separated: owner/name,owner/name')
    .option('--hn [q]', 'Hacker News stories, optionally matching a query')
    .option('--points <n>', 'Minimum HN points', (v) => parseInt(v, 10))
    .option('--days <n>', 'Only items from the last N days', (v) => parseInt(v, 10))
    .option('--reddit <subs>', 'Reddit subreddits, comma-separated (no r/ prefix)')
    .option('-n, --count <n>', 'How many items to cover', (v) => parseInt(v, 10))
    .option('--name <name>', 'Episode name, used for the slug and the default title')
    .option('--preset <preset>', 'landscape (16:9) or shorts (9:16)')
    .option('--voice <voice>', 'TTS voice: onyx, nova, alloy, echo, fable, shimmer, ...')
    .option('--music <file>', 'Background music track mixed under the episode')
}

program
  .command('auth')
  .description('One-time YouTube sign-in. Reuses the oauth-demo-recorder token if you already have one.')
  .action(async () => {
    await authenticate()
  })

program
  .command('queries')
  .description('List the saved queries in queries/.')
  .action(async () => {
    const files = (await fs.readdir(QUERIES_DIR).catch(() => [])).filter((f) => f.endsWith('.yaml'))
    if (files.length === 0) return log('No saved queries yet. Add one to ' + QUERIES_DIR)
    for (const f of files) {
      const def = parseYaml(await fs.readFile(join(QUERIES_DIR, f), 'utf8')) as QueryDef
      console.log(`${basename(f, '.yaml').padEnd(24)} ${describeSpec(def.source)}  (${def.count} items)`)
    }
  })

program
  .command('episodes')
  .description('List episodes and how far each one got.')
  .action(async () => {
    const slugs = (await fs.readdir(EPISODES_DIR).catch(() => [])).sort()
    if (slugs.length === 0) return log('No episodes yet.')
    for (const slug of slugs) {
      const p = episodePaths(slug)
      const stages = [
        (await exists(p.research)) ? 'research' : '',
        (await exists(p.script)) ? 'script' : '',
        (await exists(p.video)) ? 'video' : '',
        (await exists(p.published)) ? 'published' : '',
      ].filter(Boolean)
      console.log(`${slug.padEnd(44)} ${stages.join(' → ') || '(empty)'}`)
    }
  })

addQueryOptions(
  program
    .command('research')
    .description('Stage 1: gather the subjects for an episode into episodes/<slug>/research.json.'),
).action(async (opts) => {
  const query = await resolveQuery(opts)
  const slug = episodeSlug(query)
  const paths = episodePaths(slug)
  await fs.mkdir(paths.dir, { recursive: true })

  log(`Researching "${query.name}" — ${describeSpec(query.source)}`)
  const items = await fetchItems({ spec: query.source, count: query.count, log })
  if (items.length === 0) throw new Error('No items came back for this query. Try a wider search or a longer window.')

  await fs.writeFile(paths.research, JSON.stringify({ query, items }, null, 2))
  log(`\n${items.length} items → ${paths.research}`)
  console.log(slug)
})

program
  .command('script <slug>')
  .description('Stage 2: write the narration script to episodes/<slug>/script.yaml (edit it before rendering).')
  .option('--model <model>', 'OpenAI model for the script (default: $OPENAI_SCRIPT_MODEL or gpt-4o)')
  .option('--tone <tone>', 'How it should sound')
  .option('--force', 'Overwrite an existing script.yaml', false)
  .action(async (slug: string, opts) => {
    const paths = episodePaths(slug)
    const raw = await readJson<{ query: QueryDef; items: SourceItem[] }>(paths.research)
    if (!opts.force && (await exists(paths.script))) {
      throw new Error(`${paths.script} already exists. Edit it, or pass --force to rewrite it.`)
    }
    const query = { ...raw.query }
    if (opts.model) query.script = { ...query.script, model: opts.model }
    if (opts.tone) query.script = { ...query.script, tone: opts.tone }

    const episode = await writeEpisode({ query, items: raw.items, log })
    episode.slug = slug
    await fs.writeFile(paths.script, scriptHeader() + stringifyYaml(episode, { lineWidth: 100 }))
    log(`\nScript → ${paths.script}`)
    log(`Title:  ${episode.title}`)
    log(`Read it, tweak any narration you don't like, then: video-studio render ${slug}`)
    console.log(paths.script)
  })

program
  .command('render <slug>')
  .description('Stage 3: render episodes/<slug>/script.yaml to an MP4.')
  .option('--only <indices>', 'Re-render only these segments (0-based, comma-separated); reuse the rest')
  .option('--headed', 'Show the browser while recording walkthroughs', false)
  .action(async (slug: string, opts) => {
    const paths = episodePaths(slug)
    const episode = await readEpisode(paths.script)
    const only = opts.only
      ? String(opts.only).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
      : undefined

    const result = await renderEpisode({ episode, only, headless: !opts.headed, log })
    log(`\nVideo: ${result.videoPath}  (${formatTimestamp(result.durationSec)})`)
    if (result.chapters.length) log('Chapters:\n  ' + result.chapters.join('\n  '))
    console.log(result.videoPath)
  })

program
  .command('publish <slug>')
  .description('Stage 4: upload the rendered MP4 to YouTube with chapters and a thumbnail.')
  .option('--visibility <v>', 'public | unlisted | private')
  .option('--title <title>', 'Override the scripted title')
  .option('--no-thumbnail', 'Skip setting the custom thumbnail')
  .action(async (slug: string, opts) => {
    const paths = episodePaths(slug)
    const episode = await readEpisode(paths.script)
    if (!(await exists(paths.video))) {
      throw new Error(`No rendered video at ${paths.video}. Run: video-studio render ${slug}`)
    }
    const url = await publishEpisode({
      episode,
      slug,
      visibility: opts.visibility ?? episode.youtube.visibility,
      title: opts.title,
      thumbnail: opts.thumbnail !== false,
    })
    console.log(url)
  })

addQueryOptions(
  program
    .command('make', { isDefault: false })
    .description('Run all four stages: research → script → render → (optionally) publish.'),
)
  .option('--publish', 'Upload to YouTube when the render finishes', false)
  .option('--visibility <v>', 'public | unlisted | private (with --publish)')
  .option('--headed', 'Show the browser while recording walkthroughs', false)
  .option('--pause', 'Stop after the script so you can edit it before rendering', false)
  .action(async (opts) => {
    const query = await resolveQuery(opts)
    const slug = episodeSlug(query)
    const paths = episodePaths(slug)
    await fs.mkdir(paths.dir, { recursive: true })

    log(`\n── 1/4 research ─ ${describeSpec(query.source)}`)
    const items = await fetchItems({ spec: query.source, count: query.count, log })
    if (items.length === 0) throw new Error('No items came back for this query. Try a wider search or a longer window.')
    await fs.writeFile(paths.research, JSON.stringify({ query, items }, null, 2))

    log(`\n── 2/4 script`)
    const episode = await writeEpisode({ query, items, log })
    episode.slug = slug
    await fs.writeFile(paths.script, scriptHeader() + stringifyYaml(episode, { lineWidth: 100 }))
    log(`Title: ${episode.title}`)
    if (opts.pause) {
      log(`\nPaused. Edit ${paths.script}, then: video-studio render ${slug}`)
      return console.log(paths.script)
    }

    log(`\n── 3/4 render`)
    const result = await renderEpisode({ episode, headless: !opts.headed, log })
    log(`Video: ${result.videoPath}  (${formatTimestamp(result.durationSec)})`)

    const shouldPublish = opts.publish || episode.youtube.upload
    if (!shouldPublish) {
      log(`\n── 4/4 publish — skipped. To upload: video-studio publish ${slug}`)
      return console.log(result.videoPath)
    }
    log(`\n── 4/4 publish`)
    const url = await publishEpisode({
      episode,
      slug,
      visibility: opts.visibility ?? episode.youtube.visibility,
      thumbnail: true,
    })
    console.log(url)
  })

/** Shared by `publish` and the tail of `make`. */
async function publishEpisode(opts: {
  episode: Episode
  slug: string
  visibility: string
  title?: string
  thumbnail: boolean
}): Promise<string> {
  const paths = episodePaths(opts.slug)
  const { episode } = opts
  // Re-derive the chapters from the clips actually on disk, so an edited or
  // partially re-rendered episode still gets correct timestamps.
  const { chapters } = await chaptersFromDisk(episode, paths.clips)
  const description = [episode.description.trim(), chapters.length ? 'Chapters:\n' + chapters.join('\n') : '']
    .filter(Boolean)
    .join('\n\n')

  const url = await uploadToYouTube({
    videoPath: paths.video,
    title: opts.title ?? episode.title,
    description,
    visibility: (opts.visibility as 'public' | 'unlisted' | 'private') ?? 'unlisted',
    tags: episode.tags,
    thumbnailPath: opts.thumbnail && (await exists(paths.thumbnail)) ? paths.thumbnail : undefined,
  })
  await fs.writeFile(
    paths.published,
    JSON.stringify({ url, title: opts.title ?? episode.title, visibility: opts.visibility, at: new Date().toISOString() }, null, 2),
  )
  log(`\nYouTube: ${url}`)
  return url
}

async function chaptersFromDisk(episode: Episode, clipsDir: string): Promise<{ chapters: string[] }> {
  const { buildChapters } = await import('./render/index.ts')
  const { probeDuration } = await import('./narration.ts')
  const files = (await fs.readdir(clipsDir).catch(() => [])).filter((f) => f.endsWith('.mp4')).sort()
  const clips = []
  for (const f of files) {
    const m = f.match(/^(\d+)-(card|browse)\.mp4$/)
    if (!m) continue
    const idx = parseInt(m[1], 10)
    const seg = episode.segments[idx]
    const label = !seg
      ? f
      : seg.kind === 'intro' ? 'Intro'
      : seg.kind === 'outro' ? 'Outro'
      : seg.kind === 'repo' && seg.rank ? `#${seg.rank} ${seg.card.headline}`
      : seg.card.headline
    clips.push({
      path: join(clipsDir, f),
      durationSec: await probeDuration(join(clipsDir, f)),
      label,
      chapter: m[2] === 'card' && seg?.kind !== 'card',
    })
  }
  return { chapters: buildChapters(clips) }
}

/** Build a QueryDef from either a saved file or the ad-hoc flags. */
async function resolveQuery(opts: Record<string, unknown>): Promise<QueryDef> {
  let def: QueryDef | undefined
  if (opts.query) {
    const path = join(QUERIES_DIR, `${String(opts.query).replace(/\.yaml$/, '')}.yaml`)
    const raw = await fs.readFile(path, 'utf8').catch(() => {
      throw new Error(`No saved query at ${path}. Run \`video-studio queries\` to see what exists.`)
    })
    def = parseYaml(raw) as QueryDef
    def.name = def.name ?? String(opts.query)
  }

  const spec = specFromFlags(opts)
  if (!def && !spec) {
    throw new Error(
      'Nothing to research. Pass one of --query <saved>, --trending, --search, --repos, --hn, --reddit.\n' +
      '  e.g. video-studio make --trending --count 5\n' +
      '       video-studio make --search "topic:mcp stars:>500" --count 5',
    )
  }
  const merged: QueryDef = def ?? { name: '', source: spec!, count: 5 }
  if (spec) merged.source = spec
  if (opts.count) merged.count = Number(opts.count)
  merged.count = merged.count || 5
  if (opts.name) merged.name = String(opts.name)
  if (!merged.name) merged.name = defaultName(merged.source)
  if (opts.preset) merged.video = { ...merged.video, preset: String(opts.preset) as 'landscape' | 'shorts' }
  if (opts.voice) merged.narration = { ...merged.narration, voice: String(opts.voice) }
  if (opts.music) merged.music = { path: resolve(String(opts.music)), volume: merged.music?.volume ?? 0.12 }
  merged.video = resolveVideo(merged.video)
  return merged
}

function specFromFlags(opts: Record<string, unknown>): SourceSpec | undefined {
  const since = (opts.since as 'daily' | 'weekly' | 'monthly') ?? 'daily'
  if (opts.trending !== undefined) {
    return { type: 'github_trending', since, language: typeof opts.trending === 'string' ? opts.trending : undefined }
  }
  if (opts.search) return { type: 'github_search', query: String(opts.search), sort: 'stars' }
  if (opts.repos) {
    return { type: 'github_repos', repos: String(opts.repos).split(',').map((s) => s.trim()).filter(Boolean) }
  }
  if (opts.hn !== undefined) {
    return {
      type: 'hackernews',
      query: typeof opts.hn === 'string' ? opts.hn : undefined,
      points: opts.points as number | undefined,
      days: (opts.days as number | undefined) ?? 7,
    }
  }
  if (opts.reddit) {
    return {
      type: 'reddit',
      subreddits: String(opts.reddit).split(',').map((s) => s.trim().replace(/^r\//, '')).filter(Boolean),
      sort: 'top',
      time: 'week',
    }
  }
  return undefined
}

function defaultName(spec: SourceSpec): string {
  switch (spec.type) {
    case 'github_trending': return `trending${spec.language ? '-' + spec.language : ''}-${spec.since ?? 'daily'}`
    case 'github_search': return slugify(spec.query) || 'github-search'
    case 'github_repos': return spec.repos.length === 1 ? slugify(spec.repos[0]) : 'repo-roundup'
    case 'hackernews': return spec.query ? slugify(`hn-${spec.query}`) : 'hacker-news'
    case 'reddit': return slugify(`reddit-${spec.subreddits.join('-')}`)
  }
}

function describeSpec(spec: SourceSpec): string {
  switch (spec.type) {
    case 'github_trending': return `GitHub trending ${spec.language ?? 'all languages'} (${spec.since ?? 'daily'})`
    case 'github_search': return `GitHub search: ${spec.query}`
    case 'github_repos': return `repos: ${spec.repos.join(', ')}`
    case 'hackernews': return `Hacker News${spec.query ? `: ${spec.query}` : ''}`
    case 'reddit': return `Reddit: ${spec.subreddits.map((s) => 'r/' + s).join(', ')}`
  }
}

function episodeSlug(query: QueryDef): string {
  return slugify(`${query.name}-${today()}`)
}

function scriptHeader(): string {
  return (
    '# Edit anything here before rendering — narration, headlines, bullets, order.\n' +
    '# Re-render one changed segment with:  video-studio render <slug> --only <index>\n'
  )
}

async function readEpisode(path: string): Promise<Episode> {
  const raw = await fs.readFile(path, 'utf8').catch(() => {
    throw new Error(`No script at ${path}. Run \`video-studio script <slug>\` first.`)
  })
  return parseYaml(raw) as Episode
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await fs.readFile(path, 'utf8').catch(() => {
    throw new Error(`Missing ${path}. Run \`video-studio research\` for this episode first.`)
  })
  return JSON.parse(raw) as T
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).size > 0
  } catch {
    return false
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error('\n' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
