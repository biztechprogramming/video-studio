import type { SourceItem } from '../types.ts'

/**
 * A style is the *editorial* half of the script prompt: how a segment opens,
 * what the two halves of the narration are for, how the intro and outro
 * behave, and whether the episode is a countdown.
 *
 * What a style may NOT change is the JSON contract with the model — every
 * style returns the same keys, because the renderer and `script.yaml` are
 * downstream of all of them. Prompt wording is a style's business; card
 * fields are the writer's.
 */
export interface ScriptStyle {
  name: string
  /** One line for `video-studio styles`. */
  summary: string
  /** Tone used when the query file doesn't set one. */
  defaultTone: string
  /** words_per_segment used when the query file doesn't set one. */
  defaultWords: number
  /** Play the strongest item last and number the segments "#1"…"#n". */
  countdown: boolean
  /** Show the lineup as bullets on the intro card. */
  introLineup: boolean
  /** Hand each segment the subject that plays after it, so it can hook forward. */
  needsNextItem: boolean
  /** Eyebrow on the outro card; omitted for styles that don't sign off. */
  outroEyebrow?: string
  /** Outro headline used only if the model returns none — must still fit the style. */
  outroHeadlineFallback: string
  /** Rules appended to BASE_VOICE_RULES for every call this style makes. */
  voiceRules: string
  /** How the stats-card half and the page-scroll half split the word budget. */
  budget(words: number): { card: number; browse: number }
  /** Instructions for narration_card and narration_browse. */
  segmentRules(ctx: SegmentContext): string
  /** Instructions for intro_narration, outro_narration and the two headlines. */
  packageRules(ctx: PackageContext): string
}

export interface SegmentContext {
  item: SourceItem
  /** Position in the countdown, when the style runs one. */
  rank?: number
  /** Word budget for each half, from ScriptStyle.budget(). */
  budget: { card: number; browse: number }
  /** What plays next; undefined on the last subject. Only set when needsNextItem. */
  next?: SourceItem
}

export interface PackageContext {
  /** Subject names in playback order. */
  names: string[]
}

/**
 * True of every style: these are constraints of the medium (a voice, a
 * viewer, no screen to read off), not of an editorial voice.
 */
export const BASE_VOICE_RULES = `
Write for the ear, not the page. Hard rules:
- Plain spoken English. No markdown, no bullets, no emoji, no stage directions.
- Never read a URL, a slug, or a code fence aloud. Say "on GitHub" instead of the link.
- Expand symbols: "48.2k stars" is spoken as "forty-eight thousand stars".
- Be specific and concrete. No "revolutionary", "game-changing", "in today's fast-paced world".
- Contractions are good. Short sentences are better.
- Every claim comes from the page text you were given. Never invent a number, a name or a feature.
`.trim()

/**
 * The house style: explain the thing, then go a level deeper. Structured as a
 * countdown so a multi-item episode builds to its best subject.
 */
const explainer: ScriptStyle = {
  name: 'explainer',
  summary: 'Warm walkthrough, counted down to the best item. The default.',
  defaultTone: 'a knowledgeable developer friend showing you something cool — warm, dry, zero hype',
  defaultWords: 70,
  countdown: true,
  introLineup: true,
  needsNextItem: false,
  outroEyebrow: 'THANKS FOR WATCHING',
  outroHeadlineFallback: 'Thanks for watching',
  voiceRules: `- Say what it DOES and who it's FOR before you say anything about how popular it is.`,
  // The card is a static frame: keep it tight and let the walkthrough, which
  // has motion to carry it, take the longer half.
  budget: (words) => ({ card: Math.round(words * 0.6), browse: words }),
  segmentRules: ({ rank, budget }) =>
    `narration_card: about ${budget.card} words, spoken over a stats card` +
    `${rank ? `; this is number ${rank} in the countdown, so open by placing it` : ''}. ` +
    `Say what the project does, the problem it solves, and who should care.\n` +
    `narration_browse: about ${budget.browse} words, spoken while the viewer watches its page scroll past. ` +
    `Go one level deeper than narration_card: how it works, a standout feature, a real caveat or limitation if the text reveals one. ` +
    `Do not repeat sentences from narration_card.`,
  packageRules: () =>
    `intro_narration: 35-50 words. Say what this episode covers and tease the most interesting item without naming every one.\n` +
    `outro_narration: 20-30 words. A specific closing thought, then a light ask to subscribe. Do not promise anything that isn't in the lineup.\n` +
    `intro_headline / outro_headline: max 40 characters. subheads: max 80 characters.`,
}

/**
 * No runway. Each segment opens on the one thing about the subject that
 * shouldn't be true, resolves it in two sentences, spends the rest on why it
 * is true and what it costs, and leaves a question standing for the next one.
 *
 * Not a countdown: ranking a segment forces "coming in at number three" into
 * the opening line, which is exactly the setup this style exists to delete.
 * Items stay in best-first order instead.
 */
const coldOpen: ScriptStyle = {
  name: 'cold-open',
  summary: 'No setup. Opens mid-motion on the most surprising true fact, hooks forward.',
  defaultTone: 'confident, fast, a little deadpan — the friend who starts a story in the middle because the middle is the good part',
  defaultWords: 70,
  countdown: false,
  introLineup: false,
  needsNextItem: true,
  // A sign-off card would undo the last segment's open question.
  outroEyebrow: undefined,
  outroHeadlineFallback: 'Still open',
  voiceRules: `
Cold open. Every segment begins mid-motion, on the single most surprising true
thing about the subject, stated flatly and without setup.

Rules for the first sentence of every segment, without exception:
- It is a fact, not a frame. "This replaces forty thousand lines of C with
  eight hundred." Not "let's take a look at a project that...".
- It never contains the words "this project", "today we", "coming in at
  number", "let's dive in", or the subject's category. The viewer works out
  what it is from the second sentence, and is more interested for having
  waited.
- It survives being read aloud by itself, with no context. If it needs the
  card on screen to make sense, it is not the opening.

Find that fact by looking for the thing that should not be true: an absurd
constraint the project accepts, a number that sounds like a typo, a deliberate
refusal ("it will not run in the cloud, on purpose"), a single person
maintaining something a thousand companies depend on, a feature removed rather
than added, a design decision that looks wrong until it doesn't. It has to be
supported by the page text you were given — a surprising fact you made up is
worse than a dull one you didn't.

Never a sentence that exists to introduce another sentence. No hype words.
Never end on "check it out" or "link in the description".`.trim(),
  // Roughly 40 words over the card and 90 over the page at the default budget:
  // the opening plus its two-sentence resolution is short by construction, and
  // all of the reasoning lives in the second half.
  budget: (words) => ({ card: Math.round(words * 0.57), browse: Math.round(words * 1.3) }),
  segmentRules: ({ budget, next }) =>
    `narration_card: about ${budget.card} words, spoken over a stats card. ` +
    `Sentence one is the impossible fact, flat and unframed. Then about two sentences resolving it — what this actually is — ` +
    `so nobody is confused past the ten-second mark. Nothing else: no history, no popularity, no "and that's not all".\n` +
    `narration_browse: about ${budget.browse} words, spoken while the viewer watches its page scroll past. ` +
    `Spend it on why the surprising thing is true: the reasoning behind it, the constraint it came from, what it makes possible, ` +
    `and what it costs — name a real limitation the page text admits to.\n` +
    (next
      ? `End narration_browse on an unresolved beat that pulls into what comes next: a question that "${next.name}" (${next.description}) answers, ` +
        `or a tension you deliberately leave standing. Gesture at it; do not name it and do not describe it.`
      : `This is the last subject, so end narration_browse on the tension itself — a question left open, not tied off.`),
  packageRules: () =>
    `intro_narration: ONE sentence, 15-30 words, naming the sharpest single thing in the whole episode — ` +
    `the one fact most likely to stop someone scrolling. No greeting, no "in this video", no list of what's coming.\n` +
    `outro_narration: ONE line, 12-20 words. A thought, not a farewell: no thanks, no sign-off, no ask to subscribe.\n` +
    `intro_headline / outro_headline: max 40 characters, flat and declarative, no question marks, no exclamation marks. ` +
    `subheads: max 80 characters.`,
}

export const STYLES: Record<string, ScriptStyle> = {
  [explainer.name]: explainer,
  [coldOpen.name]: coldOpen,
}

export const DEFAULT_STYLE = explainer.name

export function listStyles(): ScriptStyle[] {
  return Object.values(STYLES)
}

/** Look up a style by name, failing with the valid names rather than a stack trace. */
export function resolveStyle(name?: string): ScriptStyle {
  const key = (name ?? DEFAULT_STYLE).trim().toLowerCase()
  const style = STYLES[key]
  if (!style) {
    throw new Error(
      `Unknown script style "${name}". Available: ${Object.keys(STYLES).join(', ')}.\n` +
      '  Run `video-studio styles` to see what each one sounds like.',
    )
  }
  return style
}
