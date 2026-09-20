import { spawn } from 'node:child_process'

/**
 * The two ffmpeg calls everything else is built out of.
 *
 * They live here rather than in `render/encode.ts` because narration needs them
 * too — a dialogue unit is assembled with ffmpeg before any video exists — and
 * `encode.ts` already reads durations back from narration. One shared leaf
 * module instead of two files importing each other.
 */

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

/** ffprobe wrapper: returns duration in seconds (float). */
export function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]
    const p = spawn('ffprobe', args)
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${stderr}`))
      const n = parseFloat(stdout.trim())
      if (!Number.isFinite(n)) return reject(new Error(`ffprobe returned non-numeric: ${stdout}`))
      resolve(n)
    })
  })
}
