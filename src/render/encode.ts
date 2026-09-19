import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { probeDuration } from '../narration.ts'

// Every clip in an episode is encoded to these exact parameters so the final
// concat can stream-copy instead of re-encoding (see concatClips).
const V_CODEC = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20']
const A_CODEC = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']

export interface ClipSize {
  width: number
  height: number
  fps: number
}

/**
 * Turn a still card into a video clip whose length is the narration length
 * (plus a little air) or an explicit minimum, whichever is longer.
 *
 * A perfectly static shot reads as a stalled video, so the card gets a slow
 * Ken Burns push — scaled up 2x first, because zoompan works on the scaled
 * frame and zooming a 1:1 image produces visible stair-stepping.
 */
export async function renderStillClip(opts: {
  imagePath: string
  audioPath?: string
  durationSec: number
  size: ClipSize
  outPath: string
  /** Fade in/out length in seconds; 0 disables. */
  fadeSec?: number
  kenBurns?: boolean
}): Promise<string> {
  const { imagePath, audioPath, size, outPath } = opts
  const fade = opts.fadeSec ?? 0.4
  const duration = Math.max(1.2, opts.durationSec)
  const frames = Math.round(duration * size.fps)
  await fs.mkdir(dirname(outPath), { recursive: true })

  const vf: string[] = []
  if (opts.kenBurns !== false) {
    vf.push(
      `scale=${size.width * 2}:${size.height * 2}`,
      `zoompan=z='min(zoom+0.0006,1.08)':d=${frames}:s=${size.width}x${size.height}:fps=${size.fps}`,
    )
  } else {
    vf.push(`scale=${size.width}:${size.height}`, `fps=${size.fps}`)
  }
  vf.push('setsar=1', 'format=yuv420p')
  if (fade > 0) {
    vf.push(`fade=t=in:st=0:d=${fade}`, `fade=t=out:st=${(duration - fade).toFixed(3)}:d=${fade}`)
  }

  const args = ['-y', '-loop', '1', '-framerate', String(size.fps), '-i', imagePath]
  if (audioPath) args.push('-i', audioPath)
  else args.push(...SILENCE)

  await runFfmpeg([
    ...args,
    '-vf', vf.join(','),
    '-t', duration.toFixed(3),
    ...V_CODEC,
    ...A_CODEC,
    // Delay the narration slightly so it doesn't start under the fade-in.
    ...(audioPath ? ['-af', `adelay=250|250,apad`] : []),
    '-map', '0:v:0', '-map', '1:a:0',
    '-shortest',
    outPath,
  ])
  return outPath
}

/**
 * Convert one browser recording (Playwright writes WebM) into a clip with the
 * same parameters as the card clips, mixing its narration in from the top.
 */
export async function renderBrowseClip(opts: {
  videoPath: string
  audioPath?: string
  size: ClipSize
  outPath: string
  /** Trim this many seconds off the head (page load, blank first frames). */
  trimStartSec?: number
  /** Crop the recording to this rect (in recorded pixels) before scaling. */
  crop?: { x: number; y: number; width: number; height: number }
}): Promise<string> {
  const { videoPath, audioPath, size, outPath } = opts
  await fs.mkdir(dirname(outPath), { recursive: true })
  const trim = opts.trimStartSec ?? 0

  const inputs = ['-y']
  if (trim > 0) inputs.push('-ss', trim.toFixed(3))
  inputs.push('-i', videoPath)
  if (audioPath) inputs.push('-i', audioPath)
  else inputs.push(...SILENCE)

  const vf = [
    ...(opts.crop
      ? [`crop=${opts.crop.width}:${opts.crop.height}:${opts.crop.x}:${opts.crop.y}`]
      : []),
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease`,
    `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12`,
    'setsar=1',
    `fps=${size.fps}`,
    'format=yuv420p',
  ]

  await runFfmpeg([
    ...inputs,
    '-vf', vf.join(','),
    // Pad the audio with silence so a short narration doesn't truncate the
    // clip: -shortest would otherwise cut the walkthrough to the voice.
    '-af', 'apad',
    ...V_CODEC,
    ...A_CODEC,
    '-map', '0:v:0', '-map', '1:a:0',
    '-shortest',
    outPath,
  ])
  return outPath
}

/**
 * Join clips into the finished episode.
 *
 * Everything this project produces already shares one codec/size/fps, so the
 * fast path is the concat demuxer with `-c copy` — no generation loss, and
 * seconds instead of minutes. If a clip was produced elsewhere (a hand-made
 * intro, an old render) the parameters won't match and stream copy would
 * desync, so we fall back to re-encoding through the concat filter.
 */
export async function concatClips(opts: {
  inputs: string[]
  outPath: string
  size: ClipSize
  workDir: string
}): Promise<string> {
  const { inputs, outPath, size, workDir } = opts
  if (inputs.length === 0) throw new Error('concat: no clips to join')
  await fs.mkdir(workDir, { recursive: true })
  await fs.mkdir(dirname(outPath), { recursive: true })

  if (inputs.length === 1) {
    await fs.copyFile(inputs[0], outPath)
    return outPath
  }

  const uniform = await allUniform(inputs, size)
  if (uniform) {
    const listPath = join(workDir, 'concat.txt')
    await fs.writeFile(listPath, inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n')
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', outPath,
    ])
    return outPath
  }

  process.stderr.write('  clips differ in codec/size/fps — re-encoding to join them\n')
  const inputArgs = inputs.flatMap((p) => ['-i', p])
  const refs = inputs
    .map((_, i) =>
      `[${i}:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
      `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${size.fps}[v${i}];` +
      `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}];`,
    )
    .join('')
  const chain = inputs.map((_, i) => `[v${i}][a${i}]`).join('')
  await runFfmpeg([
    '-y', ...inputArgs,
    '-filter_complex', `${refs}${chain}concat=n=${inputs.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]',
    ...V_CODEC, ...A_CODEC,
    '-movflags', '+faststart',
    outPath,
  ])
  return outPath
}

/**
 * Mix a music bed under the finished episode. The music is looped to length
 * and side-chain ducked by the narration, so the voice always sits on top
 * without hand-tuning levels per episode.
 */
export async function mixMusicBed(opts: {
  videoPath: string
  musicPath: string
  volume: number
  outPath: string
}): Promise<string> {
  const { videoPath, musicPath, volume, outPath } = opts
  await fs.access(musicPath).catch(() => {
    throw new Error(`Music track not found: ${musicPath}`)
  })
  const duration = await probeDuration(videoPath)
  const filter =
    `[1:a]volume=${volume},aloop=loop=-1:size=2e9,atrim=duration=${duration.toFixed(3)},` +
    `afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, duration - 2).toFixed(3)}:d=2[bed];` +
    // Duck the bed whenever the narration (the sidechain) is speaking.
    `[bed][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[ducked];` +
    `[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0,volume=1.4[aout]`

  await runFfmpeg([
    '-y', '-i', videoPath, '-i', musicPath,
    '-filter_complex', filter,
    '-map', '0:v:0', '-map', '[aout]',
    '-c:v', 'copy',
    ...A_CODEC,
    '-movflags', '+faststart',
    outPath,
  ])
  return outPath
}

/**
 * Bring the finished cut to YouTube's loudness target.
 *
 * TTS output peaks around -10 dBFS, which plays noticeably quieter than
 * everything else in a viewer's feed. loudnorm lands us at -14 LUFS with
 * -1.5 dBTP of headroom — YouTube's own normalization then leaves it alone.
 * Video is stream-copied, so this costs seconds and no quality.
 */
export async function normalizeLoudness(opts: { videoPath: string; outPath: string }): Promise<string> {
  await runFfmpeg([
    '-y', '-i', opts.videoPath,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:v', 'copy',
    ...A_CODEC,
    '-movflags', '+faststart',
    opts.outPath,
  ])
  return opts.outPath
}

interface StreamParams {
  width: number
  height: number
  fps: number
  vcodec: string
  hasAudio: boolean
}

async function allUniform(inputs: string[], size: ClipSize): Promise<boolean> {
  for (const input of inputs) {
    const p = await probeStream(input)
    if (!p) return false
    if (p.width !== size.width || p.height !== size.height) return false
    if (Math.abs(p.fps - size.fps) > 0.01) return false
    if (p.vcodec !== 'h264' || !p.hasAudio) return false
  }
  return true
}

function probeStream(path: string): Promise<StreamParams | null> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate',
      '-of', 'json', path,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve(null))
    p.on('close', () => {
      try {
        const streams = (JSON.parse(out).streams ?? []) as Record<string, string>[]
        const v = streams.find((s) => s.codec_type === 'video')
        if (!v) return resolve(null)
        const [num, den] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number)
        resolve({
          width: Number(v.width),
          height: Number(v.height),
          fps: den ? num / den : 0,
          vcodec: String(v.codec_name),
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
        })
      } catch {
        resolve(null)
      }
    })
  })
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('ffmpeg not found in PATH. Install it: apt install ffmpeg'))
      } else reject(e)
    })
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.split('\n').slice(-25).join('\n')}`))
    })
  })
}
