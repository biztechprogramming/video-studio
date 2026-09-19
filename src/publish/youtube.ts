import { google } from 'googleapis'
import type { youtube_v3 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import * as readline from 'node:readline/promises'

const TOKEN_PATH = join(homedir(), '.config', 'video-studio', 'yt-token.json')
// The sibling oauth-demo-recorder project authenticates against the same
// channel with the same scope, so if this project has no token of its own we
// borrow that one rather than making the user re-run the consent dance.
const FALLBACK_TOKEN_PATHS = [join(homedir(), '.config', 'oauth-demo-recorder', 'yt-token.json')]
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload']

function getClient(): OAuth2Client {
  const id = process.env.YOUTUBE_CLIENT_ID
  const secret = process.env.YOUTUBE_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error(
      'YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET are not set. See README → "First-time YouTube setup".',
    )
  }
  // "Desktop app" / installed-application flow uses the OOB redirect.
  return new google.auth.OAuth2(id, secret, 'urn:ietf:wg:oauth:2.0:oob')
}

async function loadSavedToken(client: OAuth2Client): Promise<boolean> {
  for (const path of [TOKEN_PATH, ...FALLBACK_TOKEN_PATHS]) {
    try {
      const raw = await fs.readFile(path, 'utf8')
      client.setCredentials(JSON.parse(raw))
      if (path !== TOKEN_PATH) {
        process.stderr.write(`Using the YouTube token from ${path}\n`)
      }
      return true
    } catch {
      /* try the next location */
    }
  }
  return false
}

async function persistToken(client: OAuth2Client): Promise<void> {
  await fs.mkdir(dirname(TOKEN_PATH), { recursive: true })
  await fs.writeFile(TOKEN_PATH, JSON.stringify(client.credentials, null, 2), { mode: 0o600 })
}

/**
 * Interactive first-time auth. Opens a URL, asks the user to paste back the
 * code shown after consent. Persists the refresh token under ~/.config.
 */
export async function authenticate(): Promise<void> {
  const client = getClient()
  if (await loadSavedToken(client)) {
    console.log('Already authenticated. Token at ' + TOKEN_PATH)
    return
  }
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })
  console.log('\nOpen this URL in a browser and grant access to the YouTube channel you want to upload to:\n')
  console.log(url)
  console.log()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const code = (await rl.question('Paste the authorization code: ')).trim()
  rl.close()
  const { tokens } = await client.getToken(code)
  client.setCredentials(tokens)
  await persistToken(client)
  console.log('Saved refresh token to ' + TOKEN_PATH)
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
  const ok = await loadSavedToken(client)
  if (!ok) {
    throw new Error(
      `No saved YouTube token at ${TOKEN_PATH}. Run \`video-studio auth\` first.`,
    )
  }
  // Refresh if needed.
  // isTokenExpiring is marked protected in google-auth-library's types but is
  // the documented way to ask; the cast keeps the check without subclassing.
  if ((client as unknown as { isTokenExpiring(): boolean }).isTokenExpiring()) {
    const { credentials } = await client.refreshAccessToken()
    client.setCredentials(credentials)
    await persistToken(client)
  }

  const youtube = google.youtube({ version: 'v3', auth: client })
  const stats = await fs.stat(opts.videoPath)
  process.stderr.write(`Uploading ${(stats.size / 1e6).toFixed(1)} MB to YouTube...\n`)

  const res = await youtube.videos.insert({
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
        `WARNING: video uploaded but the thumbnail was rejected (${err instanceof Error ? err.message.split('\n')[0] : String(err)}).\n` +
        `  Custom thumbnails need a verified YouTube channel: https://www.youtube.com/verify\n`,
      )
    }
  }
  return `https://www.youtube.com/watch?v=${id}`
}
