import { chatJson } from './openai.ts'
import { BASE_VOICE_RULES, resolveStyle, type ScriptStyle } from './styles.ts'
import type { CardContent, Episode, QueryDef, RepoSegment, Segment, SourceItem } from '../types.ts'
import { resolveVideo, slugify, today } from '../config.ts'

export const DEFAULT_SCRIPT_MODEL = process.env.OPENAI_SCRIPT_MODEL ?? 'gpt-5.6-luna'

/** The voice rules every call sees: the medium's, then the style's. */
function voiceRules(style: ScriptStyle): string {
  return [BASE_VOICE_RULES, style.voiceRules].filter(Boolean).join('\n')
}

interface SegmentDraft {
  headline: string
  subhead: string
  bullets: string[]
  narration_card: string
  narration_browse: string
}

interface PackageDraft {
  title: string
  description: string
  tags: string[]
  intro_headline: string
  intro_subhead: string
  intro_narration: string
  outro_headline: string
  outro_subhead: string
  outro_narration: string
}

/**
 * Turn researched items into a full episode script.
 *
 * Two phases on purpose: each item is written from its own README in its own
 * call (parallel, and one bad README can't poison the others), then a single
 * packaging call writes the intro, outro and YouTube metadata with all the
 * item summaries in front of it, so the intro can actually tease what's
 * coming instead of hedging.
 */
export async function writeEpisode(opts: {
  query: QueryDef
  items: SourceItem[]
  log?: (msg: string) => void
}): Promise<Episode> {
  const { query } = opts
  const log = opts.log ?? (() => {})
  const model = query.script?.model ?? DEFAULT_SCRIPT_MODEL
  const style = resolveStyle(query.script?.style)
  const tone = query.script?.tone ?? style.defaultTone
  const words = query.script?.words_per_segment ?? style.defaultWords
  const budget = style.budget(words)
  const countdown = style.countdown && opts.items.length > 1
  // Sources rank best-first, but a countdown has to *build*: play them in
  // reverse so the strongest item is the one the episode ends on, at #1.
  const items = countdown ? [...opts.items].reverse() : opts.items

  log(`Writing ${items.length} segment scripts with ${model} in the ${style.name} style...`)
  const drafts = await Promise.all(
    items.map((item, i) =>
      writeSegment({
        item,
        rank: countdown ? items.length - i : undefined,
        // Styles that hook forward need to know what they're hooking into.
        next: style.needsNextItem ? items[i + 1] : undefined,
        model,
        tone,
        style,
        budget,
      })
        .catch((err) => {
          // One failed segment shouldn't cost the whole episode: fall back to
          // the source's own description so the render still has something.
          log(`  WARNING: script for ${item.name} failed (${short(err)}); using the source description`)
          return fallbackDraft(item)
        }),
    ),
  )

  log('Writing the intro, outro and YouTube metadata...')
  const pkg = await writePackage({ query, items, drafts, model, tone, style })

  const video = resolveVideo(query.video)
  const date = today()
  const slug = slugify(`${query.name}-${date}`)

  const segments: Segment[] = []
  segments.push({
    kind: 'intro',
    card: {
      eyebrow: date,
      headline: pkg.intro_headline,
      subhead: pkg.intro_subhead,
      // A style with no setup doesn't get to spoil its own lineup on the card.
      bullets: style.introLineup ? items.map((i) => i.name) : undefined,
    },
    narration: pkg.intro_narration,
    hold: 4,
  })

  items.forEach((item, i) => {
    const d = drafts[i]
    const rank = countdown ? items.length - i : undefined
    const segment: RepoSegment = {
      kind: 'repo',
      rank,
      url: item.url,
      card: {
        eyebrow: rank ? `#${rank}` : item.source.replace('_', ' ').toUpperCase(),
        headline: d.headline || item.name,
        subhead: d.subhead || item.description,
        bullets: d.bullets?.slice(0, 3),
        stats: item.stats.slice(0, 4),
        image: typeof item.meta?.avatar === 'string' ? item.meta.avatar : undefined,
      },
      narration: d.narration_card,
      browse: {
        narration: d.narration_browse,
        // Long enough to read as a tour, short enough that the voice carries
        // it; the renderer stretches this to the narration length anyway.
        scrollSeconds: 14,
        focus: focusSelectorFor(item),
      },
    }
    segments.push(segment)
  })

  segments.push({
    kind: 'outro',
    card: { eyebrow: style.outroEyebrow, headline: pkg.outro_headline, subhead: pkg.outro_subhead },
    narration: pkg.outro_narration,
    hold: 5,
  })

  return {
    slug,
    title: query.title ? fillTemplate(query.title, { n: items.length, date, query: query.name }) : pkg.title,
    description: pkg.description,
    tags: dedupe([...(query.youtube?.tags ?? []), ...pkg.tags]).slice(0, 15),
    video,
    narration: {
      enabled: query.narration?.enabled !== false,
      voice: query.narration?.voice,
      model: query.narration?.model,
    },
    youtube: {
      upload: query.youtube?.upload ?? false,
      visibility: query.youtube?.visibility ?? 'unlisted',
    },
    music: query.music ? { path: query.music.path, volume: query.music.volume ?? 0.12 } : undefined,
    segments,
  }
}

async function writeSegment(opts: {
  item: SourceItem
  rank?: number
  next?: SourceItem
  model: string
  tone: string
  style: ScriptStyle
  budget: { card: number; browse: number }
}): Promise<SegmentDraft> {
  const { item, rank, next, model, tone, style, budget } = opts
  const statLine = item.stats.map((s) => `${s.label}: ${s.value}`).join(', ')
  const draft = await chatJson<SegmentDraft>({
    model,
    temperature: 0.7,
    maxTokens: 900,
    system:
      `You script short developer-focused YouTube videos. Tone: ${tone}.\n${voiceRules(style)}\n` +
      `Return JSON with exactly these keys: headline, subhead, bullets (array of 3 short noun phrases, max 6 words each), ` +
      `narration_card, narration_browse.\n` +
      // The headline is *displayed*, so it keeps the real spelling; only the
      // narration gets to say "llama dot cee pee pee".
      `headline: the project's own name exactly as it is written, dropping any owner prefix ` +
      `(e.g. "llama.cpp", not "Llama Dot CPP" and not "ggml-org/llama.cpp"). Max 40 chars.\n` +
      `subhead: one line, max 90 chars, what it is.\n` +
      // Everything above is the card, which every style renders identically;
      // the narration below is where the style actually lives.
      style.segmentRules({ item, rank, next, budget }),
    user:
      `Project: ${item.name}\nSource: ${item.source}\nDescription: ${item.description}\n` +
      `Stats: ${statLine}\n\n--- page/README text ---\n${item.content.slice(0, 9000)}`,
  })
  return {
    headline: String(draft.headline ?? item.name),
    subhead: String(draft.subhead ?? item.description),
    bullets: Array.isArray(draft.bullets) ? draft.bullets.map(String) : [],
    narration_card: String(draft.narration_card ?? ''),
    narration_browse: String(draft.narration_browse ?? ''),
  }
}

async function writePackage(opts: {
  query: QueryDef
  items: SourceItem[]
  drafts: SegmentDraft[]
  model: string
  tone: string
  style: ScriptStyle
}): Promise<PackageDraft> {
  const { query, items, drafts, model, tone, style } = opts
  // Each line carries the segment's own opening sentence as well as its
  // subhead, so the intro can point at the episode's sharpest *fact* rather
  // than re-describing the lineup.
  const lineup = items
    .map((item, i) =>
      `${i + 1}. ${item.name} — ${drafts[i].subhead} (${item.stats.map((s) => `${s.label} ${s.value}`).join(', ')})\n` +
      `   opens with: ${firstSentence(drafts[i].narration_card)}`)
    .join('\n')

  const pkg = await chatJson<PackageDraft>({
    model,
    temperature: 0.7,
    maxTokens: 1200,
    system:
      `You script and package short developer-focused YouTube videos. Tone: ${tone}.\n${voiceRules(style)}\n` +
      `Return JSON with exactly these keys: title, description, tags, intro_headline, intro_subhead, ` +
      `intro_narration, outro_headline, outro_subhead, outro_narration.\n` +
      `title: a YouTube title under 70 characters. Concrete and specific, no clickbait punctuation, no ALL CAPS.\n` +
      `description: 2 short paragraphs for the YouTube description box. Plain text. Do not invent links; chapter timestamps are added automatically.\n` +
      `tags: 8-12 lowercase YouTube tags.\n` +
      style.packageRules({ names: items.map((i) => i.name) }),
    user: `Episode query: ${query.name}\nDate: ${today()}\n\nLineup (in playback order):\n${lineup}`,
  })
  return {
    title: String(pkg.title ?? query.name),
    description: String(pkg.description ?? ''),
    tags: Array.isArray(pkg.tags) ? pkg.tags.map(String) : [],
    intro_headline: String(pkg.intro_headline ?? query.name),
    intro_subhead: String(pkg.intro_subhead ?? ''),
    intro_narration: String(pkg.intro_narration ?? ''),
    outro_headline: String(pkg.outro_headline || style.outroHeadlineFallback),
    outro_subhead: String(pkg.outro_subhead ?? ''),
    outro_narration: String(pkg.outro_narration ?? ''),
  }
}

/** First sentence of a block of narration, for the packaging call's lineup. */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.search(/[.!?](\s|$)/)
  return (end === -1 ? trimmed : trimmed.slice(0, end + 1)).slice(0, 200)
}

/** Where the walkthrough should start scrolling, per source. */
function focusSelectorFor(item: SourceItem): string | undefined {
  // GitHub dropped the #readme id; the rendered README body is the article.
  if (item.url.includes('github.com')) return 'article.markdown-body, #readme'
  if (item.url.includes('reddit.com')) return '[data-test-id="post-content"]'
  return undefined
}

function fallbackDraft(item: SourceItem): SegmentDraft {
  const summary = item.description || item.content.slice(0, 200)
  return {
    headline: item.name,
    subhead: item.description.slice(0, 90),
    bullets: item.stats.slice(0, 3).map((s) => `${s.label} ${s.value}`),
    narration_card: summary,
    narration_browse: '',
  }
}

function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))]
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 140)
}
