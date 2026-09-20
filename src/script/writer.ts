import { chatJson } from './openai.ts'
import type {
  CardContent,
  CastMember,
  Episode,
  FootageBeat,
  Line,
  QueryDef,
  RepoSegment,
  Segment,
  SourceItem,
  SourceSpec,
} from '../types.ts'
import { resolveVideo, slugify, today } from '../config.ts'
import { castVoices, speakerId } from '../voices/casting.ts'
import { DEFAULT_HOST_VOICE, findVoice } from '../voices/catalog.ts'
import { HOST } from '../narration.ts'

export const DEFAULT_SCRIPT_MODEL = process.env.OPENAI_SCRIPT_MODEL ?? 'gpt-5.6-luna'

const VOICE_RULES = `
Write for the ear, not the page. Hard rules:
- Plain spoken English. No markdown, no bullets, no emoji, no stage directions.
- Never read a URL, a slug, or a code fence aloud. Say "on GitHub" instead of the link.
- Expand symbols: "48.2k stars" is spoken as "forty-eight thousand stars".
- Fast, specific, confident, zero ceremony. Short sentences. Contractions.
- Every claim is checkable against the text you were given. No filler adjectives.
- Banned outright: powerful, seamless, revolutionary, game-changing, dive in,
  unlock, supercharge, "in today's fast-paced world".
`.trim()

/**
 * How the episode holds together — the hook, the handoffs, and the close.
 *
 * The first fifteen seconds decide whether anyone watches the rest, and a
 * segment that opens on its own rank spends that sentence saying something the
 * card already says. Both calls get these rules: the segment writer has to end
 * every block on a loop, the packaging call has to open one and close it.
 */
const STRUCTURE_RULES = `
The first fifteen seconds decide whether anyone watches the rest. Treat them as
the most expensive real estate in the episode.
- Never say a rank or a position out loud — no "at number five", no "coming in
  at", no "next up". The rank is already on screen; saying it wastes the one
  sentence that has to earn the next thirty seconds.
- Never open on a greeting, the date, "welcome", "this week's roundup", or a
  summary of the theme. Never describe the episode as an episode.
- Open on the sharpest fact you have: a number that sounds wrong, a refusal, a
  constraint, a thing that shouldn't be possible. Then name the project.
- End every block on an open loop — an unanswered question, a tension, a
  comparison you set up and deliberately leave standing.
`.trim()

/**
 * The format: the project is a person, and the host is interviewing it.
 *
 * This exists because a single narrator reading facts has nobody to disagree
 * with, and a video with no disagreement in it has no opinion in it. An
 * interview gets one for free — the host can ask the question the README will
 * never answer, and something has to answer it.
 */
const DIALOGUE_RULES = `
This is an interview, not narration read by two people. It is between HOST and
the project itself, which speaks in the first person as a character: "I", "my
users", "I won't do that".
- The PROJECT always speaks first, and its first line is the flat, surprising
  fact — no greeting, no "I'm a library that". It states the thing that should
  not be true and stops.
- HOST is not an announcer and never introduces anything. HOST reacts, presses,
  objects, and asks the question a skeptical developer would actually ask. HOST
  lines are SHORT — usually under ten words. The project does the explaining.
- Nobody says the other's name. Nobody says "welcome", "tell us about", "great
  question", "that's right", "absolutely", or "let's talk about".
- The project is allowed to be defensive, resigned, blunt or proud, but it is
  never a salesperson and it never uses a marketing word about itself.
- Write the turns so they interlock: a line that answers the previous one
  directly, or interrupts it. No two consecutive lines that could be swapped.
- Every fact still has to be checkable against the text you were given. The
  character is a voice, not a licence to invent.
`.trim()

/**
 * The delivery direction handed to the speech model, per project.
 *
 * This is the whole reason each project gets its own voice rather than a
 * pitch-shift: the model will act on a description of a person. It's written
 * from the project's own evidence — how old it is, what it's written in, how it
 * talks in its README — so the character is an argument about the project, not
 * a costume.
 */
const PERSONA_RULES = `
The persona is one short paragraph of stage direction for a voice actor, in the
second person: who this is, how fast they talk, what they sound like when
they're being honest about a weakness. Ground it in evidence from the README —
the language it's written in, how long it's been maintained, how many people
maintain it, how it talks about itself, what it refuses to do.
Examples of the register: "Terse and unhurried, like someone who has been
maintaining the same C file for nine years and has heard this question before.
Long pauses. Flat delivery on the numbers." / "Fast, slightly over-caffeinated,
finishes sentences early because the benchmark is the point."
Never mention accents tied to a nationality, never name a real person, never ask
for a robot voice. Max 300 characters.
`.trim()

/** How the interviewer plays it, for every episode. */
const HOST_DIRECTION =
  'Dry, quick, skeptical but not hostile. A developer who has already read the README and is ' +
  'looking for the catch. Lines land fast and end early — no warmth, no announcer polish, ' +
  'no rising presenter cadence.'

/** Pacing: roughly 40 words over the stats card, roughly 85 over the walkthrough. */
const WALKTHROUGH_WORDS = 85
const CARD_WORD_SHARE = 40 / 85

/**
 * The opening move for each segment, by playback position.
 *
 * Five segments that all open on a star count read as one segment played five
 * times, so the move is assigned here rather than left to five independent
 * calls that can't see each other's drafts.
 */
const OPENING_MOVES = [
  'a number that sounds wrong — quote it and let it land before you explain it',
  'a refusal: something this project deliberately will not do',
  'a question, asked the way a skeptic would ask it, that this project answers',
  'a comparison with whatever developers reach for today, and why that loses',
  'a constraint it works under that should make the whole thing impossible',
]

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

/** The model's answer for one project, before it becomes a segment. */
interface SegmentDraft {
  headline: string
  subhead: string
  /** The chapter title: a capability, not the project's name. */
  label: string
  bullets: string[]
  /** Stage direction for this project's voice. */
  persona: string
  dialogue_card: RawLine[]
  dialogue_browse: RawLine[]
  broll: string[]
}

/** A turn as the model returns it: `speaker` is "host" or "project". */
interface RawLine {
  speaker: string
  text: string
}

interface PackageDraft {
  title: string
  description: string
  tags: string[]
  intro_headline: string
  intro_subhead: string
  intro_dialogue: RawLine[]
  outro_headline: string
  outro_subhead: string
  outro_dialogue: RawLine[]
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
  const tone =
    query.script?.tone ??
    "fast, specific, confident, zero ceremony — someone who has already read the README and won't waste your time"
  const words = query.script?.words_per_segment ?? WALKTHROUGH_WORDS
  const cardWords = Math.max(15, Math.round(words * CARD_WORD_SHARE))
  const shortlist = nextShortlist(query.source)
  const countdown = opts.items.length > 1
  // Sources rank best-first, but a countdown has to *build*: play them in
  // reverse so the strongest item is the one the episode ends on, at #1.
  const items = countdown ? [...opts.items].reverse() : opts.items

  log(`Writing ${items.length} segment scripts with ${model}...`)
  const drafts = await Promise.all(
    items.map((item, i) =>
      writeSegment({
        item,
        // Each segment hands off to the one after it, so the writer needs to
        // know what's coming — from the research, not from a draft it can't see.
        next: items[i + 1],
        move: OPENING_MOVES[i % OPENING_MOVES.length],
        model,
        tone,
        words,
        cardWords,
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
  const pkg = await writePackage({ query, items, drafts, model, tone, shortlist })

  // Casting happens here, after the drafts, because the direction each project
  // speaks with is written by the same call that wrote its lines.
  const hostVoice = query.narration?.voice ?? DEFAULT_HOST_VOICE
  if (!findVoice(hostVoice)) {
    // Not fatal: the catalog is documentation, and the API can gain a voice
    // before this file lists it. A typo shows up here rather than at render.
    log(`  WARNING: "${hostVoice}" isn't in the voice catalog. Run \`video-studio voices\` if that's a typo.`)
  }
  const speakers = uniqueSpeakerIds(items)
  const voices = castVoices({ keys: items.map((i) => i.name), host: hostVoice })
  const cast: Record<string, CastMember> = {
    [HOST]: { voice: hostVoice, direction: HOST_DIRECTION, note: 'the interviewer' },
  }
  items.forEach((item, i) => {
    cast[speakers[i]] = {
      voice: voices.get(item.name) ?? hostVoice,
      direction: drafts[i].persona || undefined,
      note: `${item.name}, speaking for itself`,
    }
  })
  log(`Cast: ${items.map((item, i) => `${speakers[i]}=${cast[speakers[i]].voice}`).join(', ')} (host=${hostVoice})`)

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
    narration: resolveLines(pkg.intro_dialogue, items, speakers),
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
      label: d.label || undefined,
      narration: assignSpeakers(d.dialogue_card, speakers[i]),
      broll: toBeats(d.broll),
      browse: {
        narration: assignSpeakers(d.dialogue_browse, speakers[i]),
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
    // No "thanks for watching" here either: the close's job is the next
    // shortlist, so the eyebrow names when it lands.
    card: { eyebrow: shortlist.when.toUpperCase(), headline: pkg.outro_headline, subhead: pkg.outro_subhead },
    narration: resolveLines(pkg.outro_dialogue, items, speakers),
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
      voice: hostVoice,
      model: query.narration?.model,
    },
    cast,
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
  /** The subject of the next segment, so this one can hand off to it. */
  next?: SourceItem
  /** How this segment opens, assigned by position to keep the five distinct. */
  move: string
  model: string
  tone: string
  words: number
  cardWords: number
}): Promise<SegmentDraft> {
  const { item, next, move, model, tone, words, cardWords } = opts
  const handoff = next
    ? `The last turn is the HOST's, and it hands off to what's coming — ${next.name}, ${next.description} — ` +
      `without naming it: a question it answers, a shortcoming it fixes, a comparison left standing.`
    : `This is the last segment, so the HOST's last line leaves the one question the close will answer ` +
      `standing. Don't answer it here.`
  const statLine = item.stats.map((s) => `${s.label}: ${s.value}`).join(', ')
  const draft = await chatJson<SegmentDraft>({
    model,
    temperature: 0.8,
    maxTokens: 1400,
    system:
      `You script short developer-focused YouTube videos as interviews. Tone: ${tone}.\n${VOICE_RULES}\n` +
      `${STRUCTURE_RULES}\n` +
      `${DIALOGUE_RULES}\n` +
      `${PERSONA_RULES}\n` +
      `${FOOTAGE_RULES}\n` +
      `Return JSON with exactly these keys: headline, subhead, label, bullets (array of 3 short noun phrases, ` +
      `max 6 words each), persona, dialogue_card, dialogue_browse, broll.\n` +
      `Every line in dialogue_card and dialogue_browse is an object {"speaker": "host" | "project", "text": "..."}.\n` +
      // The headline is *displayed*, so it keeps the real spelling; only the
      // narration gets to say "llama dot cee pee pee".
      `headline: the project's own name exactly as it is written, dropping any owner prefix ` +
      `(e.g. "llama.cpp", not "Llama Dot CPP" and not "ggml-org/llama.cpp"). Max 40 chars.\n` +
      `subhead: one line, max 90 chars, what it is.\n` +
      // The chapter list is a menu. "#3 skyfeed" is not on any menu.
      `label: the chapter title — the capability a viewer gets, phrased as a thing they can now do, ` +
      `max 70 chars. Never the project's name, never a rank. "Track planes, ships and satellites from one ` +
      `interface", not "skyfeed".\n` +
      `persona: stage direction for THIS project's voice, following the persona rules above.\n` +
      // The card half is the shorter one: it opens the segment, and the
      // walkthrough — which shows the real thing — takes the longer half.
      `dialogue_card: 3 to 4 turns, ${cardWords} words in total, played over cinematic b-roll while a title ` +
      `card fades across it. The PROJECT opens on ${move} — stated flat, in the first person, with no ` +
      `preamble. HOST reacts in under ten words. The project then says what it is and who it's for. ` +
      `Never say its rank or where it sits in the countdown — that's on the card.\n` +
      // The one question a README is structurally incapable of answering, asked
      // out loud by someone who isn't the project. This is the opinion.
      `dialogue_browse: 4 to 6 turns, ${words} words in total, played while the viewer watches its page ` +
      `scroll past. Go a level deeper: how it actually works, and one standout detail. Somewhere in here ` +
      `HOST asks what breaks — the limitation, the thing it's bad at, who should NOT use it — and the ` +
      `project answers honestly and specifically, in its own words, without spinning it back into a ` +
      `benefit. If the README admits a limitation, use that one. Do not reuse sentences from ` +
      `dialogue_card. ${handoff}\n` +
      `broll: exactly 2 shot prompts for THIS project, following the shot prompt rules above.`,
    user:
      `Project: ${item.name}\nSource: ${item.source}\nDescription: ${item.description}\n` +
      `Stats: ${statLine}\n\n--- page/README text ---\n${item.content.slice(0, 9000)}`,
  })
  return {
    headline: String(draft.headline ?? item.name),
    subhead: String(draft.subhead ?? item.description),
    label: String(draft.label ?? ''),
    bullets: Array.isArray(draft.bullets) ? draft.bullets.map(String) : [],
    persona: String(draft.persona ?? '').slice(0, 300),
    dialogue_card: rawLines(draft.dialogue_card),
    dialogue_browse: rawLines(draft.dialogue_browse),
    broll: Array.isArray(draft.broll) ? draft.broll.map(String) : [],
  }
}

/** Keep only turns that have words in them; the rest of the shape is fixed later. */
function rawLines(value: unknown): RawLine[] {
  if (!Array.isArray(value)) return []
  return value
    .map((l) => ({ speaker: String((l as RawLine)?.speaker ?? ''), text: String((l as RawLine)?.text ?? '').trim() }))
    .filter((l) => l.text)
}

async function writePackage(opts: {
  query: QueryDef
  items: SourceItem[]
  drafts: SegmentDraft[]
  model: string
  tone: string
  shortlist: { when: string; drawnFrom: string }
}): Promise<PackageDraft> {
  const { query, items, drafts, model, tone, shortlist } = opts
  const lineup = items
    .map(
      (item, i) =>
        `${i + 1}. ${item.name} — ${drafts[i].subhead} (${item.stats.map((s) => `${s.label} ${s.value}`).join(', ')})\n` +
        // The intro's claim has to be checkable, so hand over the fact each
        // segment already leads on rather than letting the intro invent one.
        `   opens on: ${firstSentence(dialogueText(drafts[i].dialogue_card))}`,
    )
    .join('\n')
  const lastDraft = drafts[drafts.length - 1]
  const standingLoop = lastSentence(
    dialogueText(lastDraft?.dialogue_browse ?? []) || dialogueText(lastDraft?.dialogue_card ?? []),
  )
  // The intro quotes a project, so the packaging call has to be able to name
  // one; it gets the list and returns a name we map back to a speaker.
  const speakable = items.map((i) => i.name).join(', ')

  const pkg = await chatJson<PackageDraft>({
    model,
    temperature: 0.7,
    maxTokens: 1200,
    system:
      `You script and package short developer-focused YouTube videos as interviews. Tone: ${tone}.\n` +
      `${VOICE_RULES}\n` +
      `${STRUCTURE_RULES}\n` +
      `${DIALOGUE_RULES}\n` +
      `${FOOTAGE_RULES}\n` +
      `Return JSON with exactly these keys: title, description, tags, intro_headline, intro_subhead, ` +
      `intro_dialogue, outro_headline, outro_subhead, outro_dialogue, intro_broll, outro_broll.\n` +
      `intro_dialogue and outro_dialogue are arrays of {"speaker": "...", "text": "..."}. A speaker is either ` +
      `"host" or the EXACT name of one of these projects: ${speakable}.\n` +
      `title: a YouTube title under 70 characters. Concrete and specific, no clickbait punctuation, no ALL CAPS.\n` +
      `description: 2 short paragraphs for the YouTube description box. Plain text. Do not invent links; chapter timestamps are added automatically.\n` +
      `tags: 8-12 lowercase YouTube tags.\n` +
      // The cold open is the one place the format shows its hand: a stranger
      // says something impossible before anyone has introduced anything.
      `intro_dialogue: 30 words MAXIMUM across 2 or 3 turns, and it starts at zero — no greeting, no theme, ` +
      `no date. The FIRST turn belongs to the most surprising project in the lineup, speaking for itself: ` +
      `one specific, checkable claim with its own numbers, drawn from the facts below. The HOST answers in ` +
      `one short line that is the promise — what the viewer will be able to do or decide by the end, ` +
      `concretely, never "let's look at five projects". Tease that one project hard and let the rest ` +
      `arrive: don't list the others, don't name the theme.\n` +
      `outro_dialogue: 25 words MAXIMUM across 1 or 2 turns, and the last word is the HOST's. Settle the ` +
      `question the last segment left standing: "${standingLoop}". One thought, then one specific reason to ` +
      `come back — say that ${shortlist.when}'s shortlist comes from ${shortlist.drawnFrom}. A project may ` +
      `get the first line if it has the better last word. No "thanks for watching", no asking anyone to ` +
      `subscribe.\n` +
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
    intro_dialogue: rawLines(pkg.intro_dialogue),
    outro_headline: String(pkg.outro_headline ?? 'Thanks for watching'),
    outro_subhead: String(pkg.outro_subhead ?? ''),
    outro_dialogue: rawLines(pkg.outro_dialogue),
    intro_broll: Array.isArray(pkg.intro_broll) ? pkg.intro_broll.map(String) : [],
    outro_broll: Array.isArray(pkg.outro_broll) ? pkg.outro_broll.map(String) : [],
  }
}

/**
 * The one specific reason to come back, in words the outro can say out loud.
 * "Subscribe" isn't a reason; where the next shortlist comes from is, and the
 * query already knows. Search qualifiers are stripped — nobody wants to hear
 * "stars colon greater than three hundred" read aloud.
 */
function nextShortlist(spec: SourceSpec): { when: string; drawnFrom: string } {
  switch (spec.type) {
    case 'github_trending': {
      const period = spec.period ?? 'daily'
      const when = period === 'monthly' ? 'next month' : period === 'weekly' ? 'next week' : 'tomorrow'
      return { when, drawnFrom: `GitHub's ${period} trending page${spec.language ? ` for ${spec.language}` : ''}` }
    }
    case 'github_search': {
      const plain = spec.query.replace(/\S+:\S+/g, ' ').replace(/\s+/g, ' ').trim()
      return { when: 'next week', drawnFrom: plain ? `a GitHub search for ${plain}` : 'the same GitHub search' }
    }
    case 'github_repos':
      return { when: 'next week', drawnFrom: 'one project, pulled apart in full' }
    case 'hackernews': {
      const when = (spec.days ?? 7) <= 1 ? 'tomorrow' : 'next week'
      return { when, drawnFrom: `whatever Hacker News votes up${spec.query ? ` about ${spec.query}` : ''}` }
    }
    case 'reddit': {
      const when = spec.time === 'month' ? 'next month' : spec.time === 'day' ? 'tomorrow' : 'next week'
      const subs = spec.subreddits.map((s) => s.replace(/^\/?r\//, '')).join(' and ')
      return { when, drawnFrom: `the ${subs} subreddit${spec.subreddits.length > 1 ? 's' : ''}` }
    }
  }
}

/**
 * A speaker id per item, unique within the episode.
 *
 * Two projects called `cli` from different owners would otherwise share a
 * chair, and the second one would speak in the first one's voice.
 */
function uniqueSpeakerIds(items: SourceItem[]): string[] {
  const seen = new Set<string>([HOST])
  return items.map((item) => {
    const base = speakerId(item.name)
    let id = base
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`
    seen.add(id)
    return id
  })
}

/**
 * Turn the model's "host" / "project" labels into real speaker ids.
 *
 * Anything that isn't recognizably the host is the project: a model that
 * answers "Project", "llama.cpp" or "guest" still gets the right voice, and the
 * failure mode of guessing wrong is a line in the wrong mouth rather than a
 * render that dies.
 */
function assignSpeakers(lines: RawLine[], projectId: string): Line[] | undefined {
  const out = lines.map((l) => ({ speaker: isHost(l.speaker) ? HOST : projectId, text: l.text }))
  return out.length > 0 ? out : undefined
}

/**
 * The same, for the bookends, where the model names a project instead of
 * saying "project" — the intro quotes one specific item out of the lineup.
 */
function resolveLines(lines: RawLine[], items: SourceItem[], speakers: string[]): Line[] | undefined {
  const out = lines.map((l) => {
    if (isHost(l.speaker)) return { speaker: HOST, text: l.text }
    const said = l.speaker.trim().toLowerCase()
    const bare = (n: string) => n.slice(n.lastIndexOf('/') + 1).toLowerCase()
    const i = items.findIndex((it) => it.name.toLowerCase() === said || bare(it.name) === said)
    return { speaker: i >= 0 ? speakers[i] : HOST, text: l.text }
  })
  return out.length > 0 ? out : undefined
}

function isHost(speaker: string): boolean {
  return /^(host|interviewer|narrator)$/i.test(speaker.trim())
}

/** Everything said in an exchange, for word counts and for quoting one line back. */
function dialogueText(lines: RawLine[]): string {
  return lines.map((l) => l.text).join(' ')
}

/** The fact a segment leads on, as context for the intro's one claim. */
function firstSentence(text: string): string {
  const t = text.trim()
  return (t.match(/^[^.!?]*[.!?]/)?.[0] ?? t).trim().slice(0, 200)
}

/** The loop the last segment left standing, which the close has to settle. */
function lastSentence(text: string): string {
  const t = text.trim()
  const parts = t.match(/[^.!?]+[.!?]/g)
  return (parts?.[parts.length - 1] ?? t).trim().slice(0, 200)
}

/** Where the walkthrough should start scrolling, per source. */
function focusSelectorFor(item: SourceItem): string | undefined {
  // GitHub dropped the #readme id; the rendered README body is the article.
  if (item.url.includes('github.com')) return 'article.markdown-body, #readme'
  if (item.url.includes('reddit.com')) return '[data-test-id="post-content"]'
  return undefined
}

/**
 * What a segment looks like when its writing call failed.
 *
 * The project still speaks — a silent segment is worse than a plain one — but
 * it says the source's own description, in its own voice, with no persona and
 * no invented character. The host stays out of it: there's nothing here to
 * press on.
 */
function fallbackDraft(item: SourceItem): SegmentDraft {
  const summary = item.description || item.content.slice(0, 200)
  return {
    headline: item.name,
    subhead: item.description.slice(0, 90),
    label: '',
    bullets: item.stats.slice(0, 3).map((s) => `${s.label} ${s.value}`),
    persona: '',
    dialogue_card: summary ? [{ speaker: 'project', text: summary }] : [],
    dialogue_browse: [],
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
