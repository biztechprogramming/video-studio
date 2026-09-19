import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { CardRenderer } from './cards.ts'
import { recordWalkthrough } from './browse.ts'
import { concatClips, mixMusicBed, normalizeLoudness, renderBrowseClip, renderStillClip } from './encode.ts'
import { OpenAITTS, generateClips, probeDuration } from '../narration.ts'
import { episodePaths } from '../config.ts'
import type { Episode, RenderedClip, Segment } from '../types.ts'

export interface RenderResult {
  videoPath: string
  durationSec: number
  clips: RenderedClip[]
  thumbnailPath?: string
  /** "00:00 Intro" lines, ready to paste under the YouTube description. */
  chapters: string[]
}

/**
 * Render a scripted episode to a finished MP4.
 *
 * Each segment becomes its own self-contained clip on disk before anything is
 * joined. That's deliberate: a 12-minute render that dies on segment 7 leaves
 * six finished clips behind, and `--only` can re-render just the broken one.
 */
export async function renderEpisode(opts: {
  episode: Episode
  /** Re-render only these segment indices (0-based); reuse existing clips otherwise. */
  only?: number[]
  headless?: boolean
  log?: (msg: string) => void
}): Promise<RenderResult> {
  const { episode } = opts
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'))
  const paths = episodePaths(episode.slug)
  const size = episode.video
  await fs.mkdir(paths.clips, { recursive: true })
  await fs.mkdir(paths.cards, { recursive: true })

  // 1. Narration for every segment, in one batch so the TTS cache is warm and
  //    the durations are known before anything is encoded.
  const units = collectNarration(episode.segments)
  const audio = new Map<string, { path: string; durationSec: number }>()
  if (episode.narration.enabled && units.length > 0) {
    log(`Generating narration for ${units.length} lines...`)
    const tts = new OpenAITTS({ voice: episode.narration.voice, model: episode.narration.model })
    const clips = await generateClips(
      units.map((u, i) => ({ index: i, text: u.text })),
      paths.ttsCache,
      tts,
    )
    for (const c of clips) audio.set(units[c.index].key, { path: c.path, durationSec: c.durationSec })
  }

  // 2. One card renderer for the whole episode — relaunching Chromium per
  //    card would cost more than everything else in this loop.
  const cards = new CardRenderer({ width: size.width, height: size.height })
  const rendered: RenderedClip[] = []

  try {
    for (let i = 0; i < episode.segments.length; i++) {
      const seg = episode.segments[i]
      const label = segmentLabel(seg, i)
      const cardClip = join(paths.clips, `${pad(i)}-card.mp4`)
      const browseClip = join(paths.clips, `${pad(i)}-browse.mp4`)
      const wanted = !opts.only || opts.only.includes(i)

      // --- the card ---
      if (wanted || !(await exists(cardClip))) {
        const png = join(paths.cards, `${pad(i)}.png`)
        await cards.render(seg.card, png)
        const narration = audio.get(`${i}:card`)
        const hold = 'hold' in seg && seg.hold ? seg.hold : seg.kind === 'repo' ? 3 : 4
        await renderStillClip({
          imagePath: png,
          audioPath: narration?.path,
          durationSec: Math.max(hold, (narration?.durationSec ?? 0) + 1.2),
          size,
          outPath: cardClip,
        })
        log(`  ${label}: card (${(await probeDuration(cardClip)).toFixed(1)}s)`)
      }
      rendered.push({
        path: cardClip,
        durationSec: await probeDuration(cardClip),
        label,
        chapter: seg.kind !== 'card',
      })

      // --- the walkthrough ---
      if (seg.kind !== 'repo' || !seg.browse) continue
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
      rendered.push({
        path: browseClip,
        durationSec: await probeDuration(browseClip),
        label: `${label} — walkthrough`,
        chapter: false,
      })
    }

    // 3. Thumbnail from the intro card, at YouTube's 1280x720.
    let thumbnailPath: string | undefined
    const intro = episode.segments.find((s) => s.kind === 'intro')
    if (intro) {
      const thumbs = new CardRenderer({ width: 1280, height: 720 })
      try {
        thumbnailPath = await thumbs.render(intro.card, paths.thumbnail)
      } finally {
        await thumbs.close()
      }
    }

    // 4. Join, then lay the music bed under the finished cut.
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

function collectNarration(segments: Segment[]): { key: string; text: string }[] {
  const units: { key: string; text: string }[] = []
  segments.forEach((seg, i) => {
    if (seg.narration?.trim()) units.push({ key: `${i}:card`, text: seg.narration.trim() })
    if (seg.kind === 'repo' && seg.browse?.narration?.trim()) {
      units.push({ key: `${i}:browse`, text: seg.browse.narration.trim() })
    }
  })
  return units
}

function segmentLabel(seg: Segment, i: number): string {
  if (seg.kind === 'intro') return 'Intro'
  if (seg.kind === 'outro') return 'Outro'
  if (seg.kind === 'repo') return seg.rank ? `#${seg.rank} ${seg.card.headline}` : seg.card.headline
  return seg.card.headline || `Segment ${i + 1}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).size > 0
  } catch {
    return false
  }
}
