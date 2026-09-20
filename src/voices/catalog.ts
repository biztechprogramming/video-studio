/**
 * The voices an episode can be cast from, and which models can act.
 *
 * OpenAI's speech endpoint takes a fixed set of voice names; there is no API to
 * enumerate them, so they are listed here. The notes are for `video-studio
 * voices` — they're a starting point for narrowing the field, not a substitute
 * for listening. `voices --audition` is the ground truth, and it exists because
 * no one has ever picked a narrator off a text description.
 */
export interface VoiceInfo {
  id: string
  /** Rough register. Casting spreads a lineup across these so five guests don't blur into one. */
  register: 'low' | 'mid' | 'high'
  /** One line for the listing. */
  note: string
}

export const VOICES: VoiceInfo[] = [
  { id: 'alloy', register: 'mid', note: 'neutral, even, unhurried — the safe default' },
  { id: 'ash', register: 'low', note: 'dry and grounded; holds a deadpan well' },
  { id: 'ballad', register: 'mid', note: 'warm, slightly wistful; good for a project that lost an argument' },
  { id: 'coral', register: 'high', note: 'bright and quick; reads as enthusiastic without trying' },
  { id: 'echo', register: 'low', note: 'flat and measured; the one that sounds least sold on itself' },
  { id: 'fable', register: 'mid', note: 'story-teller cadence, more rise and fall than the rest' },
  { id: 'nova', register: 'high', note: 'crisp and forward; the closest thing here to a presenter' },
  { id: 'onyx', register: 'low', note: 'deep, broadcast-neutral — the current default narrator' },
  { id: 'sage', register: 'mid', note: 'patient, explanatory; sounds like it has been maintaining this for years' },
  { id: 'shimmer', register: 'high', note: 'light and airy; thin under music, fine solo' },
  { id: 'verse', register: 'mid', note: 'conversational and loose; the most obviously human of the set' },
]

export function findVoice(id: string): VoiceInfo | undefined {
  return VOICES.find((v) => v.id === id.toLowerCase())
}

/** The narrator who asks the questions, unless a query or a flag says otherwise. */
export const DEFAULT_HOST_VOICE = 'ash'

/**
 * The model default moved off `tts-1-hd` deliberately: it renders the words but
 * ignores `instructions`, and a cast without delivery direction is five timbres
 * reading the same script. Anything that can't act is still usable — the
 * provider just drops the direction and says so once.
 */
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts'

/**
 * Whether a model takes `instructions` (tone, pace, accent, attitude).
 * The `tts-1*` family does not; the `*-tts` generation does.
 */
export function canAct(model: string): boolean {
  return /-tts\b/.test(model) && !/^tts-1/.test(model)
}
