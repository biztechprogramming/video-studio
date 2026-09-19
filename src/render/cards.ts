import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'

import type { CardContent } from '../types.ts'

// Renders the full-screen title / stats cards that sit between the live
// browser walkthroughs. The markup, CSS and layout fitter all live in
// templates/card.html; this file is just the Playwright harness around it.

export interface CardTheme {
  accent: string
  background: string
  foreground: string
  muted: string
  fontFamily: string
}

export const DEFAULT_THEME: CardTheme = {
  accent: '#7c5cff',
  background: '#07080c',
  foreground: '#f3f5fa',
  // Muted sits at roughly 5:1 on the near-black background — dim enough to
  // recede behind the headline, bright enough to survive YouTube's encoder.
  muted: '#8d95a9',
  // System stack only: a card render must not depend on the network, and a
  // font that arrives late would reflow the layout after the screenshot.
  fontFamily: "ui-sans-serif, Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
}

/** templates/card.html, resolved relative to this module rather than cwd. */
const DEFAULT_TEMPLATE = fileURLToPath(new URL('../../templates/card.html', import.meta.url))

export class CardRenderer {
  readonly width: number
  readonly height: number
  readonly theme: CardTheme
  readonly templatePath: string

  private browser: Browser | null = null
  private page: Page | null = null
  /** In-flight launch, so concurrent render() calls share one browser. */
  private starting: Promise<Page> | null = null

  constructor(opts: { width: number; height: number; theme?: Partial<CardTheme>; templatePath?: string }) {
    this.width = opts.width
    this.height = opts.height
    this.theme = { ...DEFAULT_THEME, ...opts.theme }
    this.templatePath = opts.templatePath ?? DEFAULT_TEMPLATE
  }

  /**
   * Render one card to a PNG at `outPath`; returns `outPath`.
   *
   * The browser and the template page are created on first use and reused for
   * every subsequent card. An episode renders a dozen-plus cards and a
   * Chromium launch costs far more than the render itself, so relaunching per
   * card would dominate the runtime.
   */
  async render(card: CardContent, outPath: string): Promise<string> {
    const page = await this.ensurePage()
    await fs.mkdir(dirname(outPath), { recursive: true })

    const ok = await page.evaluate(
      // Typed loosely on purpose: this closure is serialized into the page,
      // where the only contract is the window.__renderCard the template
      // installs. Keeping it free of DOM types also keeps this file
      // compiling without the "dom" lib.
      (payload: { card: CardContent; theme: CardTheme }) => {
        const render = (globalThis as unknown as {
          __renderCard?: (card: unknown, theme: unknown) => Promise<boolean>
        }).__renderCard
        if (typeof render !== 'function') return Promise.resolve(false)
        return render(payload.card, payload.theme)
      },
      { card, theme: this.theme },
    )
    if (!ok) {
      throw new Error(`Card template did not install window.__renderCard: ${this.templatePath}`)
    }

    // Viewport-sized (not fullPage): the card is deliberately exactly one
    // frame, and a fullPage shot would grow if anything ever overflowed.
    await page.screenshot({ path: outPath, type: 'png' })
    return outPath
  }

  /** Free the browser. Safe to call more than once, and after a failed render. */
  async close(): Promise<void> {
    this.starting = null
    this.page = null
    const browser = this.browser
    this.browser = null
    if (browser) await browser.close()
  }

  private ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return Promise.resolve(this.page)
    if (!this.starting) {
      this.starting = this.launch().catch((err: unknown) => {
        // Don't cache a failed launch — the next render should retry.
        this.starting = null
        throw err
      })
    }
    return this.starting
  }

  private async launch(): Promise<Page> {
    const browser = await chromium.launch({
      args: [
        // Video frames are composited in sRGB; let Chromium paint them that
        // way instead of applying the display profile of whatever box this
        // runs on.
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--font-render-hinting=none',
      ],
    })
    this.browser = browser

    const context = await browser.newContext({
      viewport: { width: this.width, height: this.height },
      // 1:1 device pixels — the PNG has to match the video frame size exactly.
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'dark',
    })
    const page = await context.newPage()
    await page.goto(pathToFileURL(this.templatePath).href, { waitUntil: 'load' })
    this.page = page
    return page
  }
}
