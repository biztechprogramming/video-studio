// Shared contracts between the pipeline stages. Each stage reads the previous
// stage's JSON off disk, so they can be re-run independently:
//
//   research  →  research.json  (SourceItem[])
//   script    →  script.yaml    (Episode)          ← human-editable
//   render    →  <slug>.mp4     (+ segment clips)
//   publish   →  YouTube URL

/** One candidate subject for a segment, as returned by a source adapter. */
export interface SourceItem {
  /** Stable id within the source, e.g. "owner/name" or an HN item id. */
  id: string
  /** Where this came from: github_trending, github_search, hackernews, reddit. */
  source: string
  /** Display name, e.g. "openai/whisper" or an article title. */
  name: string
  /** Canonical URL — this is what the browser walkthrough opens. */
  url: string
  /** One-line summary from the source (repo description, HN title, …). */
  description: string
  /** Primary language, if the source knows one. */
  language?: string
  /** Total stars / points / upvotes, whatever the source counts. */
  score?: number
  /** Stars gained in the trending window, when the source reports it. */
  scoreDelta?: number
  /** Extra stats shown on the card: {label, value} pairs, already formatted. */
  stats: { label: string; value: string }[]
  /** Long-form text the script writer reads: README, article text, HN comments. */
  content: string
  /** Free-form extras (topics, owner avatar URL, HN discussion link, …). */
  meta?: Record<string, unknown>
}

/** A saved, re-runnable query: "what should this episode be about?" */
export interface QueryDef {
  name: string
  /** Episode title template. {n}, {date}, {query} are substituted. */
  title?: string
  source: SourceSpec
  /** How many items to cover. */
  count: number
  video?: {
    preset?: 'landscape' | 'shorts'
    width?: number
    height?: number
    fps?: number
    /** 'overlay' composites the card over moving footage; 'full' cuts to a still. */
    cards?: CardMode
  }
  narration?: { voice?: string; model?: string; enabled?: boolean }
  /** `words_per_segment` is the walkthrough half; the stats card gets about half of it. */
  script?: { model?: string; tone?: string; words_per_segment?: number }
  /** Generative b-roll that plays under the card overlays. */
  footage?: { enabled?: boolean; model?: string; size?: string; beat_seconds?: number }
  youtube?: {
    upload?: boolean
    visibility?: 'public' | 'unlisted' | 'private'
    tags?: string[]
    description_footer?: string
  }
  /** Optional background music track mixed under the whole episode. */
  music?: { path: string; volume?: number }
}

export type SourceSpec =
  | { type: 'github_trending'; language?: string; period?: 'daily' | 'weekly' | 'monthly'; spoken_language?: string }
  | { type: 'github_search'; query: string; sort?: 'stars' | 'updated' | 'forks'; order?: 'desc' | 'asc' }
  | { type: 'github_repos'; repos: string[] }
  | { type: 'hackernews'; query?: string; tags?: string; points?: number; days?: number }
  | { type: 'reddit'; subreddits: string[]; sort?: 'hot' | 'top' | 'new'; time?: 'day' | 'week' | 'month' }

/** What a source adapter is handed. */
export interface FetchOpts {
  spec: SourceSpec
  count: number
  /** Called with progress lines; write to stderr. */
  log: (msg: string) => void
}

/**
 * One turn in an exchange. `speaker` is a key into `Episode.cast`; "host" is
 * always the interviewer.
 */
export interface Line {
  speaker: string
  text: string
}

/**
 * What gets spoken over a clip: an exchange, or a plain string for a single
 * voice. Scripts written before the cast existed are plain strings, and still
 * render — they're read by the host.
 */
export type Narration = string | Line[]

/** Who a speaker is and how they sound. */
export interface CastMember {
  /** `provider:voice`, or a bare voice name for the default provider. */
  voice: string
  /**
   * Delivery direction for the speech model: the character, the pace, the
   * attitude. Models that can't act ignore it (see `canAct` in voices/catalog).
   */
  direction?: string
  /** What this speaker is, for the reader of script.yaml: "the project itself". */
  note?: string
}

/** The scripted episode — this is what `script.yaml` serializes to. */
export interface Episode {
  slug: string
  title: string
  description: string
  tags: string[]
  video: { width: number; height: number; fps: number }
  /**
   * How a segment's card reaches the screen. 'overlay' (the default) composites
   * it over moving footage so the episode never cuts to a slide; 'full' is the
   * old behaviour, a still frame of its own.
   */
  cards?: CardMode
  footage?: FootageSettings
  /**
   * `voice` is the host's — every other speaker is named in `cast`. Edit either
   * one in script.yaml and re-render; the TTS cache is keyed on voice and
   * direction, so only the lines that actually changed are paid for again.
   */
  narration: { enabled: boolean; voice?: string; model?: string }
  /** Speaker id → voice and direction. Always contains "host". */
  cast?: Record<string, CastMember>
  youtube: { upload: boolean; visibility: 'public' | 'unlisted' | 'private' }
  music?: { path: string; volume: number }
  segments: Segment[]
}

export type CardMode = 'overlay' | 'full'

/** Generative b-roll: the footage the card overlay sits on top of. */
export interface FootageSettings {
  enabled: boolean
  /** Video model, e.g. "sora-2". Defaults to $OPENAI_VIDEO_MODEL. */
  model?: string
  /** Generated frame size, e.g. "1280x720". Defaults to the frame's orientation. */
  size?: string
  /** Seconds to request per beat. The API only accepts a few discrete values. */
  beatSeconds?: number
}

/**
 * One generated shot. A segment carries a couple of these; the renderer uses
 * as many as the narration needs and cycles them if it needs more, so the
 * script doesn't have to know how long the voice track turned out.
 */
export interface FootageBeat {
  /** The prompt handed to the video model. */
  prompt: string
  /** Override the episode's beat length for this shot. */
  seconds?: number
}

export type Segment = CardSegment | RepoSegment

/** A standalone card: intro, outro, or a section divider. */
export interface CardSegment {
  kind: 'intro' | 'outro' | 'card'
  card: CardContent
  narration?: Narration
  /** Minimum seconds on screen, independent of narration length. */
  hold?: number
  /** Generated shots this card is composited over. */
  broll?: FootageBeat[]
}

/** A subject: its stats card, then a live walkthrough of its page. */
export interface RepoSegment {
  kind: 'repo'
  /** Position in the countdown. It shows on the card; the narration never says it. */
  rank?: number
  url: string
  card: CardContent
  /**
   * The chapter title. A capability — "Track planes, ships and satellites from
   * one interface" — not the project's name, which viewers can't search for
   * and don't yet care about.
   */
  label?: string
  /** What's said over the stats card. */
  narration?: Narration
  /** Generated shots the stats card is composited over. */
  broll?: FootageBeat[]
  /** The live-browser portion. Omit to show only the card. */
  browse?: {
    narration?: Narration
    /** Seconds of smooth scrolling through the page. */
    scrollSeconds?: number
    /** CSS selector to scroll to first (defaults to the README body). */
    focus?: string
    /** Selectors to outline as the narration mentions them. */
    highlights?: string[]
  }
}

/** Everything the HTML card template needs. */
export interface CardContent {
  /** Small line above the headline: "TRENDING #3", "INTRO". */
  eyebrow?: string
  headline: string
  subhead?: string
  bullets?: string[]
  /** {label, value} chips along the bottom: stars, language, license. */
  stats?: { label: string; value: string }[]
  /** Optional image URL (owner avatar, og:image) shown as a badge. */
  image?: string
  /** Accent colour; defaults to the theme accent. */
  accent?: string
}

/** A rendered segment clip, ready to concat. */
export interface RenderedClip {
  path: string
  durationSec: number
  /** Human label for logs and YouTube chapters. */
  label: string
  /** True for the clips that should get a chapter marker. */
  chapter: boolean
}
