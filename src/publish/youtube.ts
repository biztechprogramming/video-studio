import { google } from 'googleapis'
import type { youtube_v3 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { createReadStream, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import * as readline from 'node:readline/promises'

const TOKEN_PATH = join(homedir(), '.config', 'video-studio', 'yt-token.json')
// The sibling oauth-demo-recorder project authenticates against the same
// channel with the same scope, so if this project has no token of its own we
// borrow that one rather than making the user re-run the consent dance.
const FALLBACK_TOKEN_PATHS = [join(homedir(), '.config', 'oauth-demo-recorder', 'yt-token.json')]
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload']

/**
 * Google shut down the OOB ("copy this code") redirect, so a desktop client has
 * to catch the code on a loopback address instead. Desktop OAuth clients are
 * allowed to use any localhost port without registering it up front.
 */
function getClient(redirectUri = 'http://localhost'): OAuth2Client {
  const id = process.env.YOUTUBE_CLIENT_ID
  const secret = process.env.YOUTUBE_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error(
      'YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET are not set. See README → "First-time YouTube setup".',
    )
  }
  return new google.auth.OAuth2(id, secret, redirectUri)
}

async function loadSavedToken(client: OAuth2Client): Promise<string | null> {
  for (const path of [TOKEN_PATH, ...FALLBACK_TOKEN_PATHS]) {
    try {
      const raw = await fs.readFile(path, 'utf8')
      client.setCredentials(JSON.parse(raw))
      if (path !== TOKEN_PATH) {
        process.stderr.write(`Using the YouTube token from ${path}\n`)
      }
      return path
    } catch {
      /* try the next location */
    }
  }
  return null
}

async function persistToken(client: OAuth2Client): Promise<void> {
  await fs.mkdir(dirname(TOKEN_PATH), { recursive: true })
  await fs.writeFile(TOKEN_PATH, JSON.stringify(client.credentials, null, 2), { mode: 0o600 })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Google reports a dead/revoked refresh token as `invalid_grant`, with no other context. */
function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } }
  return e?.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(e?.message ?? '')
}

/** Turn a bare `invalid_grant` into something that says what to do about it. */
function expiredGrantError(err: unknown): Error {
  const detail = (err as { response?: { data?: { error_description?: string } } })?.response?.data
    ?.error_description
  return new Error(
    `YouTube rejected the saved sign-in: invalid_grant${detail ? ` (${detail})` : ''}\n\n` +
      `The refresh token is no longer usable. The usual causes:\n` +
      `  - the OAuth client is still in "Testing" on the Google Cloud consent screen, and\n` +
      `    testing-mode refresh tokens stop working after 7 days\n` +
      `  - access was revoked at https://myaccount.google.com/permissions\n` +
      `  - YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in .env no longer match the client\n` +
      `    that issued the token\n\n` +
      `Fix it by signing in again:  ./bin/video-studio auth --force`,
  )
}

/** Prove the saved refresh token still works, rather than trusting the expiry stamp. */
async function verifyToken(client: OAuth2Client): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!client.credentials.refresh_token) {
    return { ok: false, reason: 'The saved token has no refresh_token, so it cannot be renewed.' }
  }
  try {
    const { credentials } = await client.refreshAccessToken()
    client.setCredentials(credentials)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason: isInvalidGrant(err)
        ? 'Google rejected the saved refresh token (invalid_grant).'
        : `Could not verify the saved token: ${messageOf(err)}`,
    }
  }
}

function extractCode(input: string): string {
  const trimmed = input.trim()
  if (!/^https?:\/\//.test(trimmed)) return trimmed
  const code = new URL(trimmed).searchParams.get('code')
  if (!code) throw new Error(`No "code" parameter in ${trimmed}`)
  return code
}

/**
 * Run the consent flow: start a loopback listener, print the URL, and take the
 * code either from the redirect or from a pasted URL (for a headless box where
 * the browser is on another machine).
 */
async function consent(): Promise<void> {
  const server = createServer()
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as AddressInfo).port
  const client = getClient(`http://localhost:${port}`)
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' })

  console.log('\nOpen this URL and grant access to the YouTube channel you upload to:\n')
  console.log(url)
  console.log(
    `\nWaiting for the redirect on http://localhost:${port} ...` +
      `\n(On a remote box: finish consent in a local browser, then paste the whole` +
      `\nlocalhost URL it lands on — the page itself failing to load is expected.)\n`,
  )

  const fromBrowser = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const params = new URL(req.url ?? '/', `http://localhost:${port}`).searchParams
      const code = params.get('code')
      const error = params.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        code
          ? '<h1>video-studio is authorized.</h1><p>You can close this tab.</p>'
          : `<h1>Authorization failed</h1><p>${error ?? 'no code returned'}</p>`,
      )
      if (code) resolve(code)
      else reject(new Error(`Google returned "${error ?? 'no code'}" instead of an authorization code.`))
    })
  })

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const fromPaste = rl.question('Or paste the redirect URL / code here: ').then(extractCode)

  let code: string
  try {
    code = await Promise.race([fromBrowser, fromPaste])
  } finally {
    rl.close()
    server.close()
  }

  const { tokens } = await client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned an access token but no refresh_token, so the next upload would fail.\n' +
        'Remove this app at https://myaccount.google.com/permissions and run auth again.',
    )
  }
  client.setCredentials(tokens)
  await persistToken(client)
  console.log('\nSaved refresh token to ' + TOKEN_PATH)
}

/**
 * Sign in to YouTube. Without `force`, an existing token is checked against
 * Google first — a token that is present but dead sends you through consent
 * rather than reporting "already authenticated".
 */
export async function authenticate(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const client = getClient()
    const source = await loadSavedToken(client)
    if (source) {
      const state = await verifyToken(client)
      if (state.ok) {
        await persistToken(client)
        console.log(`Already authenticated, and the token still works. Token at ${TOKEN_PATH}`)
        return
      }
      console.log(`${state.reason}\n  (token read from ${source})\nStarting a fresh sign-in.`)
    }
  }
  await consent()
}

/**
 * Upload an MP4 to YouTube. Returns the video URL.
 */
export async function uploadToYouTube(opts: {
  videoPath: string
  title: string
  description: string
  visibility: 'public' | 'unlisted' | 'private'
  tags?: string[]
  /** YouTube category id; 28 = Science & Technology, 27 = Education. */
  categoryId?: string
  /** Local image to set as the custom thumbnail once the video exists. */
  thumbnailPath?: string
}): Promise<string> {
  const client = getClient()
  const source = await loadSavedToken(client)
  if (!source) {
    throw new Error(
      `No saved YouTube token at ${TOKEN_PATH}. Run \`./bin/video-studio auth\` first.`,
    )
  }
  // Refresh if needed.
  // isTokenExpiring is marked protected in google-auth-library's types but is
  // the documented way to ask; the cast keeps the check without subclassing.
  if ((client as unknown as { isTokenExpiring(): boolean }).isTokenExpiring()) {
    if (!client.credentials.refresh_token) {
      throw new Error(
        `The token at ${source} has expired and carries no refresh_token.\n` +
          `Sign in again:  ./bin/video-studio auth --force`,
      )
    }
    try {
      const { credentials } = await client.refreshAccessToken()
      client.setCredentials(credentials)
      await persistToken(client)
    } catch (err) {
      if (isInvalidGrant(err)) throw expiredGrantError(err)
      throw err
    }
  }

  const youtube = google.youtube({ version: 'v3', auth: client })
  const stats = await fs.stat(opts.videoPath)
  process.stderr.write(`Uploading ${(stats.size / 1e6).toFixed(1)} MB to YouTube...\n`)

  let res
  try {
    res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: opts.title,
          description: opts.description,
          tags: opts.tags ?? [],
          categoryId: opts.categoryId ?? '28', // 28 = Science & Technology.
        },
        status: {
          privacyStatus: opts.visibility,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: createReadStream(opts.videoPath),
      },
    } as youtube_v3.Params$Resource$Videos$Insert)
  } catch (err) {
    // googleapis refreshes lazily, so a dead grant can also surface here.
    if (isInvalidGrant(err)) throw expiredGrantError(err)
    throw err
  }

  const id = res.data.id
  if (!id) throw new Error('YouTube did not return a video ID')

  // A custom thumbnail needs a separate call, and it's the one part of the
  // upload that channels without the feature enabled will reject — so a
  // failure here must not lose the (already uploaded) video.
  if (opts.thumbnailPath) {
    try {
      await youtube.thumbnails.set({ videoId: id, media: { body: createReadStream(opts.thumbnailPath) } })
      process.stderr.write(`Thumbnail set from ${opts.thumbnailPath}\n`)
    } catch (err) {
      process.stderr.write(
        `WARNING: video uploaded but the thumbnail was rejected (${messageOf(err).split('\n')[0]}).\n` +
        `  Custom thumbnails need a verified YouTube channel: https://www.youtube.com/verify\n`,
      )
    }
  }
  return `https://www.youtube.com/watch?v=${id}`
}
