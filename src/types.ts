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
  video?: { preset?: 'landscape' | 'shorts'; width?: number; height?: number; fps?: number }
  narration?: { voice?: string; model?: string; enabled?: boolean }
  script?: { model?: string; tone?: string; words_per_segment?: number }
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
  | { type: 'github_trending'; language?: string; since?: 'daily' | 'weekly' | 'monthly'; spoken_language?: string }
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

/** The scripted episode — this is what `script.yaml` serializes to. */
export interface Episode {
  slug: string
  title: string
  description: string
  tags: string[]
  video: { width: number; height: number; fps: number }
  narration: { enabled: boolean; voice?: string; model?: string }
  youtube: { upload: boolean; visibility: 'public' | 'unlisted' | 'private' }
  music?: { path: string; volume: number }
  segments: Segment[]
}

export type Segment = CardSegment | RepoSegment

/** A standalone card: intro, outro, or a section divider. */
export interface CardSegment {
  kind: 'intro' | 'outro' | 'card'
  card: CardContent
  narration?: string
  /** Minimum seconds on screen, independent of narration length. */
  hold?: number
}

/** A subject: its stats card, then a live walkthrough of its page. */
export interface RepoSegment {
  kind: 'repo'
  /** Position in the countdown, for "number three" style narration. */
  rank?: number
  url: string
  card: CardContent
  /** Narration that plays over the stats card. */
  narration?: string
  /** The live-browser portion. Omit to show only the card. */
  browse?: {
    narration?: string
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
