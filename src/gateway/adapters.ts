import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Subscription-backed chat backends.
 *
 * Both are CLIs that authenticate with a consumer subscription login rather
 * than an API key, so this is the sanctioned way to spend a subscription on
 * automated work: drive the vendor's own tool. Neither speaks HTTP, so each
 * adapter is a subprocess that takes a prompt on argv and returns text.
 */

export interface ChatMessage {
  role: string
  content: string
}

export class BackendError extends Error {
  /** True when the cause is a missing/unauthenticated CLI rather than a bad request. */
  readonly unavailable: boolean
  constructor(message: string, opts: { unavailable?: boolean } = {}) {
    super(message)
    this.unavailable = opts.unavailable ?? false
  }
}

/**
 * Run a CLI to completion and return stdout.
 *
 * cwd is a temp directory on purpose: both tools pick up project context from
 * wherever they're started — CLAUDE.md, AGENTS.md, local settings — and a
 * gateway that silently seasons every completion with this repo's instructions
 * would be a baffling thing to debug from the calling side.
 */
async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; label: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return reject(new BackendError(`could not start ${cmd}: ${String(err)}`, { unavailable: true }))
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new BackendError(`${opts.label} timed out after ${opts.timeoutMs / 1000}s`))
    }, opts.timeoutMs)

    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (err.code === 'ENOENT') {
        reject(new BackendError(`${cmd} is not installed or not on PATH`, { unavailable: true }))
      } else {
        reject(new BackendError(`${cmd} failed to start: ${err.message}`, { unavailable: true }))
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new BackendError(`${opts.label} exited ${code}: ${stderr.trim().slice(0, 400) || '(no stderr)'}`))
      } else {
        resolve(stdout)
      }
    })
  })
}

/** Split messages into a system prompt and the conversation body. */
function splitMessages(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => m.content)
    .join('\n\n')
  const rest = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')
  // A single user turn is the overwhelmingly common case here and reads better
  // unlabelled; only a real multi-turn exchange gets role prefixes.
  const prompt =
    rest.length === 1 ? rest[0].content : rest.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
  return { system, prompt }
}

/**
 * Neither backend supports `response_format: { type: 'json_object' }` — that is
 * a property of the HTTP API, not of the CLIs — so JSON mode degrades to
 * asking nicely and parsing defensively. See `extractJson`.
 */
function jsonDirective(schema?: unknown): string {
  const base =
    'Respond with a single valid JSON object and nothing else: no prose, no explanation, no markdown code fences.'
  return schema ? `${base}\nIt must conform to this JSON Schema:\n${JSON.stringify(schema)}` : base
}

/**
 * Pull a JSON object out of a model reply. Even under instruction the CLIs
 * wrap JSON in fences or a sentence often enough that trusting the raw string
 * would make the pipeline fail intermittently rather than never.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : trimmed).trim()
  try {
    JSON.parse(body)
    return body
  } catch {
    /* fall through to brace slicing */
  }
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const sliced = body.slice(start, end + 1)
    try {
      JSON.parse(sliced)
      return sliced
    } catch {
      /* give the caller the original text and let it report the parse failure */
    }
  }
  return body
}

export interface AdapterOptions {
  model: string
  messages: ChatMessage[]
  jsonMode: boolean
  /** A strict JSON Schema from `response_format: json_schema`, if the caller sent one. */
  jsonSchema?: unknown
  timeoutMs: number
}

/**
 * Claude Code in print mode, authenticated by a Pro/Max login.
 *
 * The flags strip it back from an agent to a completion: no tools, no MCP
 * servers, no settings files, no session on disk. Without them every call
 * would carry the full agent harness and could decide to go read the
 * filesystem rather than answer.
 */
export async function claudeAdapter(opts: AdapterOptions): Promise<string> {
  const { system, prompt } = splitMessages(opts.messages)
  const fullSystem = [system, opts.jsonMode ? jsonDirective(opts.jsonSchema) : ''].filter(Boolean).join('\n\n')

  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--allowed-tools',
    '',
    '--no-session-persistence',
  ]
  if (fullSystem) args.push('--system-prompt', fullSystem)
  // A bare "claude" model name means "whatever the CLI defaults to".
  if (opts.model && opts.model !== 'claude') args.push('--model', opts.model)

  const stdout = await run('claude', args, { timeoutMs: opts.timeoutMs, label: 'claude' })

  let envelope: { subtype?: string; is_error?: boolean; result?: string }
  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new BackendError(`claude returned unparseable output: ${stdout.trim().slice(0, 300)}`)
  }
  if (envelope.is_error || envelope.subtype !== 'success') {
    throw new BackendError(`claude reported ${envelope.subtype ?? 'an error'}: ${String(envelope.result).slice(0, 300)}`)
  }
  const text = envelope.result ?? ''
  return opts.jsonMode ? extractJson(text) : text
}

/**
 * Codex CLI in exec mode, authenticated by a ChatGPT Plus/Pro login.
 *
 * The result is read from `--output-last-message` rather than scraped out of
 * the event stream: the JSONL carries the text at `item.completed -> item.text`,
 * nested a level deeper than the obvious guess, and a file the CLI writes
 * itself can't drift out from under us the same way.
 *
 * The flags pare it back from an agent to a completion — read-only sandbox, no
 * user config, no session files on disk — for the same reason the Claude
 * adapter does: a gateway answering a chat request should not be able to go
 * rummaging through the filesystem.
 */
export async function codexAdapter(opts: AdapterOptions): Promise<string> {
  const { system, prompt } = splitMessages(opts.messages)
  const directives = [system, opts.jsonMode ? jsonDirective(opts.jsonSchema) : ''].filter(Boolean).join('\n\n')
  const fullPrompt = directives ? `${directives}\n\n---\n\n${prompt}` : prompt

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const lastMessagePath = join(tmpdir(), `gw-codex-${stamp}.txt`)
  // Only a strict schema is usable: Codex forwards it as an OpenAI structured
  // output, which rejects anything without `additionalProperties: false`. A
  // bare `json_object` request has no schema to forward, so it stays
  // prompt-and-parse.
  const schemaPath = opts.jsonSchema ? join(tmpdir(), `gw-schema-${stamp}.json`) : undefined

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    'read-only',
    '--output-last-message',
    lastMessagePath,
  ]
  if (schemaPath) args.push('--output-schema', schemaPath)
  if (opts.model && opts.model !== 'codex') args.push('--model', opts.model)
  args.push(fullPrompt)

  let stdout = ''
  try {
    if (schemaPath) await writeFile(schemaPath, JSON.stringify(opts.jsonSchema), 'utf8')
    stdout = await run('codex', args, { timeoutMs: opts.timeoutMs, label: 'codex' })

    let text = ''
    try {
      text = (await readFile(lastMessagePath, 'utf8')).trim()
    } catch {
      /* the CLI exited 0 without writing the file — fall back to the stream */
    }
    if (!text) text = lastAgentMessage(stdout)
    if (!text) {
      throw new BackendError(
        `codex produced no assistant message. Raw output: ${stdout.trim().slice(0, 300) || '(empty)'}`,
      )
    }
    return opts.jsonMode ? extractJson(text) : text
  } finally {
    await rm(lastMessagePath, { force: true }).catch(() => {})
    if (schemaPath) await rm(schemaPath, { force: true }).catch(() => {})
  }
}

/** Last assistant message in a `codex exec --json` event stream. */
function lastAgentMessage(stdout: string): string {
  let text = ''
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let evt: { item?: { type?: string; text?: string } }
    try {
      evt = JSON.parse(t)
    } catch {
      continue
    }
    if (evt.item?.type === 'agent_message' && typeof evt.item.text === 'string' && evt.item.text.trim()) {
      text = evt.item.text
    }
  }
  return text
}
