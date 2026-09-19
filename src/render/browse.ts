import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { buildCursorInitScript, moveCursorTo } from './cursor.ts'
import type { ClipSize } from './encode.ts'

/**
 * Record a walkthrough of one page: open it, settle, then scroll slowly
 * through the interesting part (a repo's README, an article's body) for as
 * long as the narration lasts.
 *
 * The scroll is the whole visual interest of the segment, so it's animated
 * frame-by-frame with an eased velocity rather than a single
 * `scrollIntoView` — a smooth crawl reads well at 30fps, a jump does not.
 */
export async function recordWalkthrough(opts: {
  url: string
  size: ClipSize
  outDir: string
  /** Seconds of scrolling; the clip is roughly this plus the settle time. */
  scrollSeconds: number
  /** Selector to start from, e.g. the README body. First match wins. */
  focus?: string
  /** Selectors outlined in the accent colour as the scroll passes them. */
  highlights?: string[]
  accent?: string
  /** Page zoom; defaults to a readable layout width for the frame shape. */
  zoom?: number
  headless?: boolean
  log?: (msg: string) => void
}): Promise<{ videoPath: string; durationMs: number; crop?: CropRect }> {
  const { url, size, outDir, scrollSeconds } = opts
  const log = opts.log ?? (() => {})
  const accent = opts.accent ?? '#22c55e'
  const videoDir = join(outDir, 'raw')
  // Playwright names each recording with a random suffix, so a stale webm from
  // an earlier take would be indistinguishable from this run's. Start clean.
  await fs.rm(videoDir, { recursive: true, force: true })
  await fs.mkdir(videoDir, { recursive: true })

  const browser: Browser = await chromium.launch({
    headless: opts.headless !== false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--hide-scrollbars'],
  })
  // A 1920px-wide layout puts body copy at 16px in a 1080p frame — unreadable
  // on a phone. Zooming the page instead of shrinking the viewport keeps the
  // recording full-frame (Playwright pads rather than upscales a smaller
  // viewport) while laying the content out at a comfortable ~1280px width.
  // Portrait is recorded oversampled and then cropped to the content column
  // (see below), so it records larger than the delivered frame; the crop then
  // scales back down and stays sharp.
  const portrait = size.height > size.width
  const oversample = portrait ? 1.5 : 1
  const capture = {
    width: Math.round(size.width * oversample),
    height: Math.round(size.height * oversample),
  }
  // Target CSS layout width: ~1280px reads well in a 16:9 frame; a 9:16 frame
  // has far less width to spend, so it lays out narrower and leans on the crop.
  const targetLayoutWidth = portrait ? 760 : 1280
  const zoom = opts.zoom ?? Math.max(1, capture.width / targetLayoutWidth)
  const context: BrowserContext = await browser.newContext({
    viewport: { width: capture.width, height: capture.height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    recordVideo: { dir: videoDir, size: capture },
  })
  if (zoom !== 1) {
    await context.addInitScript(`(() => {
      const apply = () => {
        if (!document.documentElement) return requestAnimationFrame(apply)
        document.documentElement.style.zoom = '${zoom}'
      }
      apply()
    })()`)
  }
  await context.addInitScript(buildCursorInitScript({ size: 28, color: 'rgba(34,197,94,0.9)' }))
  // GitHub renders light first and only swaps to dark once its JS reads the
  // colour scheme, so the opening second of every take flashed white. Its
  // preference cookie settles the theme before the first paint instead.
  await context.addCookies([
    // `preferred_color_mode` is the one GitHub honours before its JS runs;
    // the color_mode JSON alone still painted one light second.
    { name: 'preferred_color_mode', value: 'dark', domain: '.github.com', path: '/' },
    { name: 'tz', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', domain: '.github.com', path: '/' },
    {
      name: 'color_mode',
      value: JSON.stringify({
        color_mode: 'dark',
        light_theme: { name: 'light', color_mode: 'light' },
        dark_theme: { name: 'dark', color_mode: 'dark' },
      }),
      domain: '.github.com',
      path: '/',
    },
  ])

  const page: Page = await context.newPage()
  const start = Date.now()
  let crop: CropRect | undefined
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    // networkidle often never fires on GitHub (long-polling); a short settle
    // beat is enough for fonts and the README to paint.
    await page.waitForTimeout(1800)
    await dismissOverlays(page)

    if (opts.focus) {
      await page
        .locator(opts.focus)
        .first()
        .scrollIntoViewIfNeeded({ timeout: 4000 })
        .catch(() => log(`  (focus selector not found: ${opts.focus})`))
      await page.waitForTimeout(600)
    }

    // Park the visible cursor somewhere plausible instead of the top-left.
    await page.evaluate(moveCursorTo(Math.round((capture.width / zoom) * 0.55), Math.round((capture.height / zoom) * 0.45)))

    for (const sel of opts.highlights ?? []) {
      await highlight(page, sel, accent).catch(() => {})
    }

    if (portrait) crop = await measureContentColumn(page, opts.focus, size, capture)

    await smoothScroll(page, scrollSeconds)
  } finally {
    await page.close()
    await context.close() // flushes the video to disk
    await browser.close()
  }
  const durationMs = Date.now() - start

  const files = (await fs.readdir(videoDir)).filter((f) => f.endsWith('.webm'))
  if (files.length === 0) throw new Error(`No recording was produced in ${videoDir}`)
  const stats = await Promise.all(files.map(async (f) => ({ f, st: await fs.stat(join(videoDir, f)) })))
  stats.sort((a, b) => b.st.size - a.st.size)
  return { videoPath: join(videoDir, stats[0].f), durationMs, crop }
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Find the band of the recording the page's actual content occupies.
 *
 * GitHub keeps its README in a column with a fixed maximum width and reserves
 * the sidebar's gutter even when the sidebar is hidden, so a 9:16 recording is
 * a third empty. Overriding its CSS doesn't stick, so we measure the content
 * and crop to it instead.
 *
 * The crop is given the delivered frame's aspect ratio, so the result scales
 * cleanly with no letterboxing: a narrow column in a tall frame means fewer
 * lines on screen at a larger size, which is what a phone wants anyway.
 */
async function measureContentColumn(
  page: Page,
  focus: string | undefined,
  target: { width: number; height: number },
  capture: { width: number; height: number },
): Promise<CropRect | undefined> {
  const selectors = [focus, 'article.markdown-body', 'main', '[role="main"]'].filter(Boolean) as string[]
  for (const sel of selectors) {
    // boundingBox() is already in viewport pixels — the page's CSS zoom is
    // baked in — and deviceScaleFactor is 1, so these are recording pixels.
    const box = await page.locator(sel).first().boundingBox().catch(() => null)
    if (!box || box.width < 50) continue
    const pad = 24
    const x = Math.max(0, Math.round(box.x - pad))
    const width = Math.min(capture.width - x, Math.round(box.width + pad * 2))
    // Not worth cropping if the content already fills the frame.
    if (width >= capture.width * 0.92) return undefined
    const height = Math.min(capture.height, Math.round((width * target.height) / target.width))
    return { x, y: Math.round((capture.height - height) / 2), width, height }
  }
  return undefined
}

/**
 * Scroll the page over `seconds`, easing in and out, and stopping cleanly at
 * the bottom instead of grinding against it for the rest of the take.
 */
async function smoothScroll(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (durationSec: number) => {
    const startY = window.scrollY
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    // Don't try to cover more than ~4 viewports: past that the text is a blur.
    const target = Math.min(maxY, startY + window.innerHeight * 4)
    if (target <= startY) return
    const t0 = performance.now()
    const total = durationSec * 1000
    await new Promise<void>((done) => {
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / total)
        // smoothstep: gentle acceleration and a soft landing
        const eased = t * t * (3 - 2 * t)
        window.scrollTo(0, startY + (target - startY) * eased)
        if (t < 1) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
  }, seconds)
}

async function highlight(page: Page, selector: string, color: string): Promise<void> {
  await page.evaluate(
    ({ sel, color }) => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return
      el.style.outline = `3px solid ${color}`
      el.style.outlineOffset = '4px'
      el.style.borderRadius = '6px'
      setTimeout(() => {
        el.style.outline = ''
      }, 4000)
    },
    { sel: selector, color },
  )
}

/**
 * Cookie banners and sign-in interstitials would otherwise be the star of the
 * shot. Best-effort: dismiss the common ones and move on.
 */
async function dismissOverlays(page: Page): Promise<void> {
  const dismissers = [
    'button:has-text("Accept all")',
    'button:has-text("Accept cookies")',
    'button:has-text("I agree")',
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
  ]
  for (const sel of dismissers) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 250 }).catch(() => false)) {
      await el.click({ timeout: 1000 }).catch(() => {})
      await page.waitForTimeout(250)
    }
  }
  // GitHub's "sign up" bottom banner and Reddit's app nag sit over the content.
  await page
    .evaluate(() => {
      const junk = [
        '.js-notice-dismiss',
        '[data-testid="bottom-bar"]',
        '.signup-prompt-bg',
        'dialog[open]',
        '#onetrust-banner-sdk',
      ]
      for (const sel of junk) document.querySelectorAll(sel).forEach((n) => n.remove())
    })
    .catch(() => {})
}
