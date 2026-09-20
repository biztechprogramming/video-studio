import { chatJson } from './openai.ts'
import type { CardContent, Episode, FootageBeat, QueryDef, RepoSegment, Segment, SourceItem } from '../types.ts'
import { resolveVideo, slugify, today } from '../config.ts'

export const DEFAULT_SCRIPT_MODEL = process.env.OPENAI_SCRIPT_MODEL ?? 'gpt-5.6-luna'

const VOICE_RULES = `
Write for the ear, not the page. Hard rules:
- Plain spoken English. No markdown, no bullets, no emoji, no stage directions.
- Never read a URL, a slug, or a code fence aloud. Say "on GitHub" instead of the link.
- Expand symbols: "48.2k stars" is spoken as "forty-eight thousand stars".
- Say what it DOES and who it's FOR before you say anything about how popular it is.
- Be specific and concrete. No "revolutionary", "game-changing", "in today's fast-paced world".
- Contractions are good. Short sentences are better.
`.trim()

/**
 * How to write a shot prompt for the video model.
 *
 * These shots are what replaced the full-frame slides, so a safe prompt is a
 * failed prompt — a generic "developer at a desk" plate is just a slide that
 * moves. The three priorities are ordered, and the order is the point: when
 * being accurate would mean being boring, the model is told to be interesting.
 */
const FOOTAGE_RULES = `
Shot prompts, in STRICT priority order:
1. CREATIVE, above everything. A striking image with a point of view: a
   metaphor, not an illustration. Never a person at a keyboard, never a screen,
   terminal, dashboard, IDE or UI, never a server room, never glowing code or
   blue holographic networks. If it could headline a stock footage site, throw
   it out and write a stranger one.
2. ACTION. Something moves for the whole shot — matter transforming, a machine
   working, weather, liquid, a swarm, a collapse, an assembly. State the motion
   explicitly, and state the camera move.
3. RELEVANT. The metaphor should map onto what this specific project does: its
   mechanism, not its category.
Each prompt is ONE sentence of 25-45 words, in this order: the subject, what it
is doing, the camera move, then the light and palette.
Never ask for text, letters, numbers, logos, brand marks, interfaces or
recognizable people — the model renders them badly and the title card already
supplies the words.
`.trim()

interface SegmentDraft {
  headline: string
  subhead: string
  bullets: string[]
  narration_card: string
  narration_browse: string
  broll: string[]
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
  intro_broll: string[]
  outro_broll: string[]
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
  const tone = query.script?.tone ?? 'a knowledgeable developer friend showing you something cool — warm, dry, zero hype'
  const words = query.script?.words_per_segment ?? 70
  const countdown = opts.items.length > 1
  // Sources rank best-first, but a countdown has to *build*: play them in
  // reverse so the strongest item is the one the episode ends on, at #1.
  const items = countdown ? [...opts.items].reverse() : opts.items

  log(`Writing ${items.length} segment scripts with ${model}...`)
  const drafts = await Promise.all(
    items.map((item, i) =>
      writeSegment({ item, rank: countdown ? items.length - i : undefined, model, tone, words })
        .catch((err) => {
          // One failed segment shouldn't cost the whole episode: fall back to
          // the source's own description so the render still has something.
          log(`  WARNING: script for ${item.name} failed (${short(err)}); using the source description`)
          return fallbackDraft(item)
        }),
    ),
  )

  log('Writing the intro, outro and YouTube metadata...')
  const pkg = await writePackage({ query, items, drafts, model, tone })

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
      bullets: items.map((i) => i.name),
    },
    narration: pkg.intro_narration,
    hold: 4,
    broll: toBeats(pkg.intro_broll),
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
      broll: toBeats(d.broll),
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
    card: { eyebrow: 'THANKS FOR WATCHING', headline: pkg.outro_headline, subhead: pkg.outro_subhead },
    narration: pkg.outro_narration,
    hold: 5,
    broll: toBeats(pkg.outro_broll),
  })

  return {
    slug,
    title: query.title ? fillTemplate(query.title, { n: items.length, date, query: query.name }) : pkg.title,
    description: pkg.description,
    tags: dedupe([...(query.youtube?.tags ?? []), ...pkg.tags]).slice(0, 15),
    video,
    cards: query.video?.cards ?? 'overlay',
    footage: {
      enabled: query.footage?.enabled !== false,
      model: query.footage?.model,
      size: query.footage?.size,
      beatSeconds: query.footage?.beat_seconds,
    },
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
  model: string
  tone: string
  words: number
}): Promise<SegmentDraft> {
  const { item, rank, model, tone, words } = opts
  const statLine = item.stats.map((s) => `${s.label}: ${s.value}`).join(', ')
  const draft = await chatJson<SegmentDraft>({
    model,
    temperature: 0.7,
    maxTokens: 900,
    system:
      `You script short developer-focused YouTube videos. Tone: ${tone}.\n${VOICE_RULES}\n` +
      `${FOOTAGE_RULES}\n` +
      `Return JSON with exactly these keys: headline, subhead, bullets (array of 3 short noun phrases, max 6 words each), ` +
      `narration_card, narration_browse, broll.\n` +
      // The headline is *displayed*, so it keeps the real spelling; only the
      // narration gets to say "llama dot cee pee pee".
      `headline: the project's own name exactly as it is written, dropping any owner prefix ` +
      `(e.g. "llama.cpp", not "Llama Dot CPP" and not "ggml-org/llama.cpp"). Max 40 chars.\n` +
      `subhead: one line, max 90 chars, what it is.\n` +
      // The card half is the shorter one: it opens the segment, and the
      // walkthrough — which shows the real thing — takes the longer half.
      `narration_card: about ${Math.round(words * 0.6)} words, spoken over cinematic b-roll while a title card fades across it` +
      `${rank ? `; this is number ${rank} in the countdown, so open by placing it` : ''}. ` +
      `Say what the project does, the problem it solves, and who should care.\n` +
      `narration_browse: about ${words} words, spoken while the viewer watches its page scroll past. ` +
      `Go one level deeper than narration_card: how it works, a standout feature, a real caveat or limitation if the text reveals one. ` +
      `Do not repeat sentences from narration_card.\n` +
      `broll: exactly 2 shot prompts for THIS project, following the shot prompt rules above.`,
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
    broll: Array.isArray(draft.broll) ? draft.broll.map(String) : [],
  }
}

async function writePackage(opts: {
  query: QueryDef
  items: SourceItem[]
  drafts: SegmentDraft[]
  model: string
  tone: string
}): Promise<PackageDraft> {
  const { query, items, drafts, model, tone } = opts
  const lineup = items
    .map((item, i) => `${i + 1}. ${item.name} — ${drafts[i].subhead} (${item.stats.map((s) => `${s.label} ${s.value}`).join(', ')})`)
    .join('\n')

  const pkg = await chatJson<PackageDraft>({
    model,
    temperature: 0.7,
    maxTokens: 1200,
    system:
      `You script and package short developer-focused YouTube videos. Tone: ${tone}.\n${VOICE_RULES}\n` +
      `${FOOTAGE_RULES}\n` +
      `Return JSON with exactly these keys: title, description, tags, intro_headline, intro_subhead, ` +
      `intro_narration, outro_headline, outro_subhead, outro_narration, intro_broll, outro_broll.\n` +
      `title: a YouTube title under 70 characters. Concrete and specific, no clickbait punctuation, no ALL CAPS.\n` +
      `description: 2 short paragraphs for the YouTube description box. Plain text. Do not invent links; chapter timestamps are added automatically.\n` +
      `tags: 8-12 lowercase YouTube tags.\n` +
      `intro_narration: 35-50 words. Say what this episode covers and tease the most interesting item without naming every one.\n` +
      `outro_narration: 20-30 words. A specific closing thought, then a light ask to subscribe. Do not promise anything that isn't in the lineup.\n` +
      `intro_headline / outro_headline: max 40 characters. subheads: max 80 characters.\n` +
      `intro_broll / outro_broll: 2 shot prompts each, following the shot prompt rules above. ` +
      `The intro's shots are about the episode's theme as a whole, not any single item; ` +
      `the outro's should feel like a closing image, not a summary.`,
    user: `Episode query: ${query.name}\nDate: ${today()}\n\nLineup (in playback order):\n${lineup}`,
  })
  return {
    title: String(pkg.title ?? query.name),
    description: String(pkg.description ?? ''),
    tags: Array.isArray(pkg.tags) ? pkg.tags.map(String) : [],
    intro_headline: String(pkg.intro_headline ?? query.name),
    intro_subhead: String(pkg.intro_subhead ?? ''),
    intro_narration: String(pkg.intro_narration ?? ''),
    outro_headline: String(pkg.outro_headline ?? 'Thanks for watching'),
    outro_subhead: String(pkg.outro_subhead ?? ''),
    outro_narration: String(pkg.outro_narration ?? ''),
    intro_broll: Array.isArray(pkg.intro_broll) ? pkg.intro_broll.map(String) : [],
    outro_broll: Array.isArray(pkg.outro_broll) ? pkg.outro_broll.map(String) : [],
  }
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
    // No prompt is better than a bad prompt: an empty list makes the renderer
    // fall back to a still card rather than pay for a generic shot.
    broll: [],
  }
}

/** Turn the model's list of shot prompts into beats the renderer can use. */
function toBeats(prompts: string[]): FootageBeat[] | undefined {
  const list = prompts.map((p) => String(p).trim()).filter(Boolean).slice(0, 3)
  return list.length > 0 ? list.map((prompt) => ({ prompt })) : undefined
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
