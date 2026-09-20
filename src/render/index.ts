import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { CardRenderer } from './cards.ts'
import { recordWalkthrough } from './browse.ts'
import {
  buildMontage,
  concatClips,
  mixMusicBed,
  normalizeLoudness,
  renderBrowseClip,
  renderFootageClip,
  renderStillClip,
} from './encode.ts'
import { DEFAULT_FOOTAGE_MODEL, FootageUnavailableError, buildFootage, defaultFootageSize } from './footage.ts'
import { HOST, OpenAITTS, generateNarration, probeDuration, toLines, type NarrationUnit } from '../narration.ts'
import { DEFAULT_HOST_VOICE } from '../voices/catalog.ts'
import { episodePaths } from '../config.ts'
import type { CastMember, Episode, RenderedClip, Segment } from '../types.ts'

export interface RenderResult {
  videoPath: string
  durationSec: number
  clips: RenderedClip[]
  thumbnailPath?: string
  /** "00:00 Intro" lines, ready to paste under the YouTube description. */
  chapters: string[]
}

/** Default seconds requested per generated shot. */
const DEFAULT_BEAT_SECONDS = 8

/**
 * Render a scripted episode to a finished MP4.
 *
 * Each segment becomes its own self-contained clip on disk before anything is
 * joined. That's deliberate: a 12-minute render that dies on segment 7 leaves
 * six finished clips behind, and `--only` can re-render just the broken one.
 *
 * Segments are built out of order. Every repo segment is rendered first, then
 * the intro and outro, because the intro is cut from the footage the rest of
 * the episode generated — it teases the actual shots rather than listing the
 * lineup on a slide.
 */
export async function renderEpisode(opts: {
  episode: Episode
  /** Re-render only these segment indices (0-based); reuse existing clips otherwise. */
  only?: number[]
  headless?: boolean
  /** Force generated b-roll off, whatever the script says. */
  footage?: boolean
  log?: (msg: string) => void
}): Promise<RenderResult> {
  const { episode } = opts
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'))
  const paths = episodePaths(episode.slug)
  const size = episode.video
  await fs.mkdir(paths.clips, { recursive: true })
  await fs.mkdir(paths.cards, { recursive: true })

  // Cards ride over moving footage by default; 'full' restores the old
  // behaviour of cutting to a still frame of its own.
  const cardMode = episode.cards ?? 'overlay'
  const footageCfg = episode.footage
  const footageModel = footageCfg?.model ?? DEFAULT_FOOTAGE_MODEL
  const footageSize = footageCfg?.size ?? defaultFootageSize(size.width, size.height)
  const beatSeconds = footageCfg?.beatSeconds ?? DEFAULT_BEAT_SECONDS
  // Mutable: the first "this account can't generate video" answer turns it off
  // for the rest of the run instead of timing out once per segment.
  let footageEnabled =
    cardMode === 'overlay' && opts.footage !== false && footageCfg?.enabled !== false

  // 1. Narration for every segment, in one batch so the TTS cache is warm and
  //    the durations are known before anything is encoded.
  const units = collectNarration(episode.segments)
  let audio = new Map<string, { path: string; durationSec: number }>()
  if (episode.narration.enabled && units.length > 0) {
    const cast = resolveCast(episode)
    const speakers = new Set(units.flatMap((u) => u.lines.map((l) => l.speaker)))
    log(`Generating narration: ${units.flatMap((u) => u.lines).length} lines, ${speakers.size} voices...`)
    const tts = new OpenAITTS({ voice: cast[HOST].voice, model: episode.narration.model })
    audio = await generateNarration({ units, cacheDir: paths.ttsCache, tts, cast, log })
  }

  // 2. One card renderer for the whole episode — relaunching Chromium per
  //    card would cost more than everything else in this loop.
  const cards = new CardRenderer({ width: size.width, height: size.height })
  const clipsByIndex = new Map<number, RenderedClip[]>()

  /** How long a segment's card holds: its narration plus air, or its floor. */
  const leadDuration = (i: number, seg: Segment): number => {
    const narration = audio.get(`${i}:card`)
    const hold = 'hold' in seg && seg.hold ? seg.hold : seg.kind === 'repo' ? 3 : 4
    return Math.max(hold, (narration?.durationSec ?? 0) + 1.2)
  }

  /** True when this segment's lead clip has to be produced on this run. */
  const leadWanted = async (i: number): Promise<boolean> =>
    !opts.only || opts.only.includes(i) || !(await exists(join(paths.clips, `${pad(i)}-card.mp4`)))

  /** The b-roll this segment's card sits on, or undefined to fall back to a still. */
  const backingFor = async (i: number, seg: Segment, durationSec: number): Promise<string | undefined> => {
    if (!footageEnabled) return undefined
    const beats = seg.broll ?? []
    if (beats.length === 0) return undefined
    try {
      return await buildFootage({
        beats,
        durationSec,
        size: footageSize,
        model: footageModel,
        beatSeconds,
        outPath: join(paths.footage, `${pad(i)}.mp4`),
        cacheDir: paths.footageCache,
        log,
      })
    } catch (err) {
      if (err instanceof FootageUnavailableError) {
        footageEnabled = false
        log(`  ${err.message}\n  Falling back to still cards for the rest of this episode.`)
      } else {
        log(`  WARNING: footage generation failed (${short(err)}); using a still card for this segment`)
      }
      return undefined
    }
  }

  /**
   * The lead clip of a segment: its card, over footage if we have any.
   *
   * `backing` wins over generation when the caller already has something
   * better in hand — the intro hands in a montage cut from the episode's own
   * shots, which is both more relevant than anything a prompt would produce
   * and free.
   */
  const buildLead = async (i: number, seg: Segment, backing?: string): Promise<RenderedClip> => {
    const out = join(paths.clips, `${pad(i)}-card.mp4`)
    const label = segmentLabel(seg, i)

    if (await leadWanted(i)) {
      const narration = audio.get(`${i}:card`)
      const durationSec = leadDuration(i, seg)
      const footage = backing ?? (await backingFor(i, seg, durationSec))

      if (footage) {
        const hero = join(paths.cards, `${pad(i)}-hero.png`)
        const badge = join(paths.cards, `${pad(i)}-badge.png`)
        await cards.render(seg.card, hero, 'hero')
        await cards.render(seg.card, badge, 'badge')
        await renderFootageClip({
          footagePath: footage,
          audioPath: narration?.path,
          heroPath: hero,
          badgePath: badge,
          durationSec,
          size,
          outPath: out,
        })
        log(`  ${label}: footage + card overlay (${durationSec.toFixed(1)}s)`)
      } else {
        const png = join(paths.cards, `${pad(i)}.png`)
        await cards.render(seg.card, png, 'full')
        await renderStillClip({
          imagePath: png,
          audioPath: narration?.path,
          durationSec,
          size,
          outPath: out,
        })
        log(`  ${label}: still card (${durationSec.toFixed(1)}s)`)
      }
    }
    return { path: out, durationSec: await probeDuration(out), label, chapter: seg.kind !== 'card' }
  }

  try {
    // 3. Every segment except the bookends. The intro needs their footage.
    for (let i = 0; i < episode.segments.length; i++) {
      const seg = episode.segments[i]
      if (seg.kind === 'intro' || seg.kind === 'outro') continue
      const label = segmentLabel(seg, i)
      const clips = [await buildLead(i, seg)]

      if (seg.kind === 'repo' && seg.browse) {
        const browseClip = join(paths.clips, `${pad(i)}-browse.mp4`)
        const wanted = !opts.only || opts.only.includes(i)
        if (wanted || !(await exists(browseClip))) {
          const narration = audio.get(`${i}:browse`)
          // Scroll for as long as the voice talks, so the motion and the words
          // end together; the configured value is the floor.
          const scrollSeconds = Math.max(seg.browse.scrollSeconds ?? 12, (narration?.durationSec ?? 0) - 1.5)
          log(`  ${label}: recording ${seg.url} (${scrollSeconds.toFixed(0)}s scroll)`)
          const { videoPath, crop } = await recordWalkthrough({
            url: seg.url,
            size,
            outDir: join(paths.dir, 'browse', pad(i)),
            scrollSeconds,
            focus: seg.browse.focus,
            highlights: seg.browse.highlights,
            headless: opts.headless,
            log,
          })
          await renderBrowseClip({
            videoPath,
            audioPath: narration?.path,
            size,
            outPath: browseClip,
            trimStartSec: 0.5,
            crop,
          })
        }
        clips.push({
          path: browseClip,
          durationSec: await probeDuration(browseClip),
          label: `${label} — walkthrough`,
          chapter: false,
        })
      }
      clipsByIndex.set(i, clips)
    }

    // 4. The bookends, cut from what the episode just produced.
    const montageSources = await collectMontageSources(paths, episode.segments)
    for (let i = 0; i < episode.segments.length; i++) {
      const seg = episode.segments[i]
      if (seg.kind !== 'intro' && seg.kind !== 'outro') continue
      let backing: string | undefined
      // The intro montage is strictly better than a generated shot — it *is*
      // the episode. It also costs nothing to cut, so --no-footage (which only
      // turns off the paid generation) still gets one; only 'full' card mode
      // opts out. Skipped entirely when the intro clip is being reused, so a
      // `--only 2` re-render doesn't pay to re-encode a montage nobody wants.
      if (cardMode === 'overlay' && seg.kind === 'intro' && montageSources.length >= 2 && (await leadWanted(i))) {
        backing = await cutMontage({
          sources: montageSources,
          size,
          durationSec: leadDuration(i, seg),
          outPath: join(paths.footage, 'intro.mp4'),
          log,
        })
      }
      clipsByIndex.set(i, [await buildLead(i, seg, backing)])
    }

    const rendered: RenderedClip[] = []
    for (let i = 0; i < episode.segments.length; i++) rendered.push(...(clipsByIndex.get(i) ?? []))

    // 5. Thumbnail from the intro card. Always the opaque variant: a
    //    transparent PNG is not a thumbnail.
    let thumbnailPath: string | undefined
    const intro = episode.segments.find((s) => s.kind === 'intro')
    if (intro) {
      const thumbs = new CardRenderer({ width: 1280, height: 720 })
      try {
        thumbnailPath = await thumbs.render(intro.card, paths.thumbnail, 'full')
      } finally {
        await thumbs.close()
      }
    }

    // 6. Join, then lay the music bed under the finished cut.
    log(`Joining ${rendered.length} clips...`)
    const joined = join(paths.dir, 'joined.mp4')
    await concatClips({
      inputs: rendered.map((c) => c.path),
      outPath: joined,
      size,
      workDir: join(paths.dir, '.concat'),
    })
    let mastered = joined
    if (episode.music) {
      log(`Mixing music bed (${episode.music.path})...`)
      mastered = join(paths.dir, 'with-music.mp4')
      await mixMusicBed({
        videoPath: joined,
        musicPath: episode.music.path,
        volume: episode.music.volume,
        outPath: mastered,
      })
    }
    log('Normalizing loudness...')
    await normalizeLoudness({ videoPath: mastered, outPath: paths.video })
    await fs.rm(joined, { force: true })
    if (mastered !== joined) await fs.rm(mastered, { force: true })

    const durationSec = await probeDuration(paths.video)
    return { videoPath: paths.video, durationSec, clips: rendered, thumbnailPath, chapters: buildChapters(rendered) }
  } finally {
    await cards.close()
  }
}

/**
 * What the intro can be cut from, best first: the b-roll the segments
 * generated, else the walkthrough recordings. Read off disk rather than
 * tracked through the loop, so `--only` re-renders still find the rest of the
 * episode's footage instead of falling back to a slide.
 */
async function collectMontageSources(
  paths: ReturnType<typeof episodePaths>,
  segments: Segment[],
): Promise<string[]> {
  const isBookend = (i: number) => segments[i]?.kind === 'intro' || segments[i]?.kind === 'outro'
  const pick = async (dir: string, re: RegExp): Promise<string[]> => {
    const files = (await fs.readdir(dir).catch(() => [])).sort()
    const out: string[] = []
    for (const f of files) {
      const m = f.match(re)
      if (!m) continue
      const i = parseInt(m[1], 10)
      if (!segments[i] || isBookend(i)) continue
      if (await exists(join(dir, f))) out.push(join(dir, f))
    }
    return out
  }
  const generated = await pick(paths.footage, /^(\d+)\.mp4$/)
  if (generated.length > 0) return generated
  return pick(paths.clips, /^(\d+)-browse\.mp4$/)
}

async function cutMontage(opts: {
  sources: string[]
  size: { width: number; height: number; fps: number }
  durationSec: number
  outPath: string
  log: (msg: string) => void
}): Promise<string | undefined> {
  try {
    return await buildMontage({
      inputs: opts.sources,
      size: opts.size,
      durationSec: opts.durationSec,
      outPath: opts.outPath,
    })
  } catch (err) {
    opts.log(`  WARNING: intro montage failed (${short(err)}); falling back`)
    return undefined
  }
}

/** YouTube reads "0:00 Title" lines in the description as chapter markers. */
export function buildChapters(clips: RenderedClip[]): string[] {
  const lines: string[] = []
  let t = 0
  for (const clip of clips) {
    // YouTube requires the first chapter to start at 0:00, and chapters to be
    // at least 10 seconds apart — skip markers that would break either rule.
    if (clip.chapter && (lines.length === 0 || t - lastStamp(lines) >= 10)) {
      lines.push(`${formatTimestamp(lines.length === 0 ? 0 : t)} ${clip.label}`)
    }
    t += clip.durationSec
  }
  return lines
}

function lastStamp(lines: string[]): number {
  const m = lines[lines.length - 1]?.match(/^(\d+):(\d+)(?::(\d+))?/)
  if (!m) return 0
  return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2])
}

export function formatTimestamp(sec: number): string {
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad2(m)}:${pad2(rest)}` : `${m}:${pad2(rest)}`
}

function collectNarration(segments: Segment[]): NarrationUnit[] {
  const units: NarrationUnit[] = []
  segments.forEach((seg, i) => {
    const card = toLines(seg.narration)
    if (card.length > 0) units.push({ key: `${i}:card`, lines: card })
    if (seg.kind === 'repo') {
      const browse = toLines(seg.browse?.narration)
      if (browse.length > 0) units.push({ key: `${i}:browse`, lines: browse })
    }
  })
  return units
}

/**
 * The speaking parts, with the host's chair filled however the episode asked.
 *
 * `cast.host` wins over `narration.voice`, because the cast is the thing a
 * human edits: both are written by the same call at script time, so the only
 * way they can disagree is that someone changed one of them on purpose, and
 * `cast` is the one the file invites you to change. `narration.voice` still
 * covers scripts written before the cast existed.
 *
 * A speaker with no entry — a hand-written line, a renamed key — falls back to
 * the host rather than failing the render.
 */
function resolveCast(episode: Episode): Record<string, CastMember> {
  const cast: Record<string, CastMember> = { ...(episode.cast ?? {}) }
  const host = cast[HOST]
  cast[HOST] = {
    ...host,
    voice: host?.voice ?? episode.narration.voice ?? DEFAULT_HOST_VOICE,
  }
  return cast
}

/**
 * What this segment is called in the logs and in the YouTube chapter list.
 *
 * A repo segment prefers its `label` — the capability it gives you — over its
 * headline: "Track planes, ships and satellites from one interface" is a thing
 * someone searches for, and "#3 skyfeed" is not.
 */
function segmentLabel(seg: Segment, i: number): string {
  if (seg.kind === 'intro') return 'Intro'
  if (seg.kind === 'outro') return 'Outro'
  if (seg.kind === 'repo') {
    const name = seg.label?.trim() || seg.card.headline
    return seg.rank ? `#${seg.rank} ${name}` : name
  }
  return seg.card.headline || `Segment ${i + 1}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 140)
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).size > 0
  } catch {
    return false
  }
}
