import http from 'node:http'
import { BackendError, claudeAdapter, codexAdapter, type AdapterOptions, type ChatMessage } from './adapters.ts'

/**
 * A local gateway that speaks the OpenAI HTTP API and answers it from more
 * than one place.
 *
 * Chat goes to a subscription-backed CLI; everything else — speech, video —
 * is proxied upstream to OpenAI with a real key, because no subscription
 * covers those and a gateway that only handled chat would force every caller
 * to know which stage to point where. Fronting all of it is what lets
 * OPENAI_BASE_URL be set once, permanently, in .env.
 */

export const DEFAULT_PORT = 4000
const DEFAULT_UPSTREAM = 'https://api.openai.com/v1'
/** Subscription CLIs are slow: a cold start plus reasoning can run minutes. */
const BACKEND_TIMEOUT_MS = 10 * 60_000

/**
 * Where proxied requests go. Deliberately NOT OPENAI_BASE_URL — that one now
 * points at this server, so reading it here would make the gateway its own
 * upstream and spin until the socket pool gave out.
 */
function upstream(): string {
  const raw = process.env.OPENAI_UPSTREAM_BASE_URL?.trim() || DEFAULT_UPSTREAM
  return raw.replace(/\/+$/, '')
}

type Route = 'claude' | 'codex' | 'passthrough'

/**
 * Pick a backend from the model name. `claude-*` is the only prefix that
 * belongs to one vendor unambiguously; everything else is assumed to be an
 * OpenAI-family name and goes to Codex. Prefix a model with `api:` to force it
 * upstream to the metered API instead — the escape hatch for when you want the
 * real thing without editing .env.
 */
export function routeFor(model: string): Route {
  if (model.startsWith('api:')) return 'passthrough'
  if (/^claude/i.test(model)) return 'claude'
  return 'codex'
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** An error in the shape callers already parse, so their handling just works. */
function sendError(res: http.ServerResponse, status: number, message: string, code: string): void {
  send(res, status, { error: { message, code, type: 'gateway_error' } })
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Proxy verbatim to OpenAI. Speech returns MP3 bytes and video returns MP4
 * bytes, so the body is moved as a Buffer rather than text — decoding it as
 * UTF-8 would corrupt every clip in a way that only shows up at playback.
 */
async function passthrough(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, log: Log): Promise<void> {
  // The upstream base already carries the /v1 prefix and so does the incoming
  // path, since callers build `${base}/audio/speech`. Appending both verbatim
  // produced /v1/v1/audio/speech, which OpenAI 404s. Strip one. A caller whose
  // base URL omits /v1 sends an unprefixed path and is unaffected.
  const target = `${upstream()}${(req.url ?? '').replace(/^\/v1(?=\/|$)/, '')}`
  const headers: Record<string, string> = { }
  // The caller's key wins; the gateway's own is the fallback, so a client that
  // has been told it doesn't need a key still gets a working upstream call.
  const auth = req.headers.authorization
  const key = process.env.OPENAI_API_KEY?.trim()
  if (auth && !/Bearer\s+unused$/i.test(auth)) headers.Authorization = auth
  else if (key) headers.Authorization = `Bearer ${key}`
  else {
    return sendError(
      res,
      401,
      `No OpenAI key available for ${req.url}. Speech and video have no subscription backend, so the gateway ` +
        `proxies them upstream and needs OPENAI_API_KEY in its own environment.`,
      'no_upstream_key',
    )
  }
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type'])

  log(`proxy  ${req.method} ${req.url} -> ${upstream()}`)
  const upstreamRes = await fetch(target, {
    method: req.method,
    headers,
    // Uint8Array view rather than the Buffer itself: undici accepts both at
    // runtime, but only the view matches the BodyInit type.
    body: body.length ? new Uint8Array(body) : undefined,
  })
  const buf = Buffer.from(await upstreamRes.arrayBuffer())
  const out: Record<string, string> = {}
  const ct = upstreamRes.headers.get('content-type')
  if (ct) out['content-type'] = ct
  out['content-length'] = String(buf.length)
  res.writeHead(upstreamRes.status, out)
  res.end(buf)
}

interface ChatBody {
  model?: string
  messages?: ChatMessage[]
  response_format?: { type?: string; json_schema?: { schema?: unknown } }
}

async function handleChat(res: http.ServerResponse, body: Buffer, log: Log): Promise<void> {
  let parsed: ChatBody
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return sendError(res, 400, 'Request body is not valid JSON.', 'invalid_request')
  }
  const model = (parsed.model ?? '').trim()
  const messages = parsed.messages ?? []
  if (!messages.length) return sendError(res, 400, 'No messages in request.', 'invalid_request')

  const route = routeFor(model)
  // Both flavours of structured output mean "JSON only" to the adapters; only
  // json_schema carries something Codex can enforce rather than be asked.
  const rf = parsed.response_format
  const jsonMode = rf?.type === 'json_object' || rf?.type === 'json_schema'
  const jsonSchema = rf?.type === 'json_schema' ? rf.json_schema?.schema : undefined
  log(`chat   ${model || '(unnamed)'} -> ${route}${jsonMode ? ' [json]' : ''}`)

  if (route === 'passthrough') {
    // Strip the marker before it reaches OpenAI, which has never heard of it.
    const rewritten = Buffer.from(JSON.stringify({ ...parsed, model: model.slice('api:'.length) }))
    const fakeReq = {
      url: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    } as http.IncomingMessage
    return passthrough(fakeReq, res, rewritten, log)
  }

  const opts: AdapterOptions = { model, messages, jsonMode, jsonSchema, timeoutMs: BACKEND_TIMEOUT_MS }
  const started = Date.now()
  try {
    const content = route === 'claude' ? await claudeAdapter(opts) : await codexAdapter(opts)
    log(`   ok   ${route} in ${Math.round((Date.now() - started) / 1000)}s, ${content.length} chars`)
    send(res, 200, {
      id: `chatcmpl-gw-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      // Subscription backends don't bill per token, so there is nothing
      // truthful to report here. Zeros beat inventing numbers.
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`   FAIL ${route}: ${message}`)
    if (err instanceof BackendError && err.unavailable) {
      // 4xx on purpose: a missing CLI will still be missing on the retry, and
      // the caller's backoff would just delay the message that fixes it.
      return sendError(
        res,
        400,
        `The "${route}" backend is unavailable: ${message}. ` +
          (route === 'codex'
            ? 'Install Codex CLI and run `codex login` to use a ChatGPT subscription, or set OPENAI_SCRIPT_MODEL to a claude-* model to use the Claude subscription instead.'
            : 'Install Claude Code and sign in, or set OPENAI_SCRIPT_MODEL to a non-claude model.'),
        'backend_unavailable',
      )
    }
    sendError(res, 502, `The "${route}" backend failed: ${message}`, 'backend_failed')
  }
}

type Log = (msg: string) => void

export function createServer(opts: { log?: Log } = {}): http.Server {
  const log = opts.log ?? (() => {})
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.url === '/healthz') return send(res, 200, { ok: true, upstream: upstream() })
        const body = await readBody(req)
        if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
          return await handleChat(res, body, log)
        }
        await passthrough(req, res, body, log)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log(`   FAIL ${req.method} ${req.url}: ${message}`)
        if (!res.headersSent) sendError(res, 502, message, 'gateway_failure')
        else res.end()
      }
    })()
  })
}

export async function startGateway(opts: { port?: number; log?: Log } = {}): Promise<http.Server> {
  const port = opts.port ?? Number(process.env.OPENAI_GATEWAY_PORT ?? DEFAULT_PORT)
  const server = createServer({ log: opts.log })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}
