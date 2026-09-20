import { DEFAULT_PORT, startGateway } from './server.ts'
import { loadEnv } from '../config.ts'

// The gateway proxies speech and video upstream, so it needs the real
// OPENAI_API_KEY from .env — loaded before anything reads the environment.
loadEnv()

const port = Number(process.env.OPENAI_GATEWAY_PORT ?? DEFAULT_PORT)

// Guard against the obvious foot-gun: .env now points callers at this server,
// and if that value were also used as the upstream the gateway would proxy to
// itself until the socket pool gave out. Only this port is disqualified —
// another local gateway, or a mock, is a legitimate thing to sit in front of.
const upstream = process.env.OPENAI_UPSTREAM_BASE_URL?.trim()
if (upstream) {
  try {
    const u = new URL(upstream)
    const self = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname) && Number(u.port) === port
    if (self) {
      process.stderr.write(`OPENAI_UPSTREAM_BASE_URL points at ${upstream}, which is this gateway. Refusing to proxy to myself.\n`)
      process.exit(1)
    }
  } catch {
    process.stderr.write(`OPENAI_UPSTREAM_BASE_URL is not a valid URL: ${upstream}\n`)
    process.exit(1)
  }
}
const log = (msg: string) => process.stderr.write(`${msg}\n`)

try {
  await startGateway({ port, log })
} catch (err) {
  const e = err as NodeJS.ErrnoException
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${port} is already in use — the gateway may already be running.\n`)
    process.exit(1)
  }
  throw err
}

process.stderr.write(
  `llm-gateway listening on http://127.0.0.1:${port}/v1\n` +
    `  chat    claude-* -> claude CLI, everything else -> codex CLI, api:<model> -> upstream\n` +
    `  speech  proxied to ${process.env.OPENAI_UPSTREAM_BASE_URL ?? 'https://api.openai.com/v1'}\n` +
    `  video   proxied to ${process.env.OPENAI_UPSTREAM_BASE_URL ?? 'https://api.openai.com/v1'}\n` +
    `Ctrl-C to stop.\n\n`,
)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    process.stderr.write('\nstopping\n')
    process.exit(0)
  })
}
