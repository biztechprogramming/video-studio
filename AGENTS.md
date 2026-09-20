# video-studio — notes for agents

Node ≥22 TypeScript, run directly (`node --experimental-strip-types src/cli.ts`);
there is no build step, and imports carry the `.ts` extension. `npx tsc --noEmit`
is the typecheck.

## Layout

| Path | Role |
| --- | --- |
| `src/types.ts` | The contract between stages. Change it deliberately. |
| `src/cli.ts` | Commands: research, script, render, publish, make, episodes, queries, auth. |
| `src/sources/` | One adapter per source; all return `SourceItem[]` via `fetchItems()`. |
| `src/script/` | OpenAI narration + YouTube metadata writing. |
| `src/script/styles.ts` | The editorial voices `--style` picks between. |
| `src/render/` | Cards (Chromium screenshot), walkthroughs (Chromium recording), ffmpeg. |
| `src/publish/` | YouTube Data API upload. |
| `queries/` | Saved query definitions (`QueryDef`). |
| `episodes/` | Per-episode working dirs. Git-ignored. |

## Conventions that matter

- **Stages are files on disk.** `research.json` → `script.yaml` → clips → MP4.
  Never fuse two stages: the user edits `script.yaml` between them.
- **Everything is resumable.** Each segment renders to its own clip; TTS is
  content-addressed in `episodes/<slug>/.tts-cache`. A re-render of unchanged
  narration must not call an API.
- **All clips share one codec/size/fps** (see the constants at the top of
  `src/render/encode.ts`) so the final concat can stream-copy. If you add a
  clip type, encode it with those same constants.
- **Styles own prompt wording, not the JSON contract.** Every entry in
  `src/script/styles.ts` returns the same keys, because `script.yaml`, the
  renderer and the publisher are downstream of all of them. A new style is a
  new object in `STYLES` — no other file should need to change.
- **stdout is the result** (a slug, a path, a URL); progress goes to stderr.
- **Missing config prompts, it doesn't crash** — use `requireEnv()` from
  `src/config.ts`, which writes the answer back to `.env`.
- **Network calls get timeouts and retries.** A hung fetch must never stall a
  render that has already spent minutes of browser time.
- Sibling project `../oauth-demo-recorder` is where the TTS, cursor and upload
  code came from. Fixes worth sharing usually apply to both.
