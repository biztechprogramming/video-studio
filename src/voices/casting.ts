import { createHash } from 'node:crypto'
import { VOICES, findVoice, type VoiceInfo } from './catalog.ts'

/**
 * Casting: which voice a project speaks in.
 *
 * Deterministic on the project's own identity, not on its position in the
 * lineup, so llama.cpp sounds like llama.cpp in every episode it appears in —
 * a returning project should be recognizable before its name is on screen.
 *
 * Two things bend that rule, both inside one episode: a guest never takes the
 * host's voice, and no two guests share one. Everything else about the lineup —
 * its order, its length, which other projects are in it — is deliberately kept
 * out of the decision. The cast is written into `script.yaml`, which is where
 * to pin a voice when the hash picks badly.
 */

/** Stable 0..n-1 index for a string. */
function hashIndex(key: string, n: number): number {
  const digest = createHash('sha256').update(key).digest()
  return digest.readUInt32BE(0) % n
}

export interface CastRequest {
  /** Project identities, in playback order: "owner/name" or a URL. */
  keys: string[]
  /** The interviewer's voice. Never handed to a guest. */
  host: string
}

/**
 * Assign one voice per key. Returns a map in the order requested.
 *
 * The only input to a project's first choice is the project's own name, so the
 * assignment does not move when the lineup is reordered or when a project is
 * dropped from an episode. Uniqueness is the one thing that can override it: if
 * two projects in one episode hash to the same voice, the collision is resolved
 * in sorted-key order — deterministic, and still independent of playback order.
 *
 * An earlier version also tried to alternate registers between consecutive
 * guests. It sounded marginally better and broke stability outright, because a
 * voice chosen from the previous guest's register changes whenever the running
 * order does. Spread comes from the width of the pool instead; what actually
 * separates two guests is their direction, not their pitch.
 */
export function castVoices(req: CastRequest): Map<string, string> {
  const pool = VOICES.filter((v) => v.id !== req.host.toLowerCase())
  const out = new Map<string, string>()
  if (pool.length === 0) return out

  const taken = new Set<string>()
  // Sorted, so which project wins a contested voice doesn't depend on the
  // countdown; the caller still gets its own order back.
  for (const key of [...req.keys].sort()) {
    const start = hashIndex(key, pool.length)
    const pick = walk(pool, start, (v) => !taken.has(v.id)) ?? pool[start]
    out.set(key, pick.id)
    taken.add(pick.id)
  }
  return new Map(req.keys.map((k) => [k, out.get(k)!]))
}

/** First voice at or after `start` (wrapping) that satisfies `ok`. */
function walk(pool: VoiceInfo[], start: number, ok: (v: VoiceInfo) => boolean): VoiceInfo | undefined {
  for (let i = 0; i < pool.length; i++) {
    const v = pool[(start + i) % pool.length]
    if (ok(v)) return v
  }
  return undefined
}

/**
 * A speaker id usable as a YAML key and readable in a diff: "llama-cpp" for
 * ggml-org/llama.cpp. The host is always "host".
 */
export function speakerId(name: string): string {
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const slug = bare
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'guest'
}

/**
 * Split a `provider:voice` address. A bare voice name means OpenAI, which is
 * the only provider today; the prefix exists so saved queries and scripts don't
 * have to be rewritten when there's a second one.
 */
export function parseVoice(spec: string): { provider: string; voice: string } {
  const i = spec.indexOf(':')
  if (i === -1) return { provider: 'openai', voice: spec.trim().toLowerCase() }
  return {
    provider: spec.slice(0, i).trim().toLowerCase() || 'openai',
    voice: spec.slice(i + 1).trim().toLowerCase(),
  }
}

/**
 * Reject an unknown voice at script time rather than at render time. A typo in
 * `--voice` costs nothing here and costs a whole render three stages later.
 */
export function assertVoice(spec: string): string {
  const { provider, voice } = parseVoice(spec)
  if (provider !== 'openai') {
    throw new Error(`Unknown speech provider "${provider}". Only "openai" is wired up today.`)
  }
  if (!findVoice(voice)) {
    throw new Error(`Unknown voice "${voice}". Run \`video-studio voices\` to see the list.`)
  }
  return voice
}
