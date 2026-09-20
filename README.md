# video-studio

Turns a query — GitHub trending, a GitHub search, an explicit repo list,
Hacker News, Reddit — into a narrated YouTube video: for each subject, a title
card riding over generated b-roll, then a live scroll through its actual page,
joined with an intro cut from the episode's own footage and uploaded with
chapters and a thumbnail.

Nothing in the finished cut is a static slide. Cards are composited over
moving footage and hand off to a lower third; see [Cards and footage](#cards-and-footage).

Shares its DNA (and its YouTube token) with the sibling `oauth-demo-recorder`
project: same Playwright recording, same OpenAI TTS with a content-addressed
cache, same ffmpeg mux.

## Pipeline

```
query ─► research ─► script ─► render ─► publish
         │           │          │          │
         │           │          │          └─ YouTube: title, description,
         │           │          │             chapters, tags, thumbnail
         │           │          └─ b-roll (video model) + cards composited
         │           │             over it (Chromium screenshot, alpha)
         │           │             + walkthroughs (Chromium recording, smooth
         │           │             scroll, animated cursor) → ffmpeg concat
         │           └─ OpenAI writes per-segment narration, intro/outro and
         │              the YouTube metadata → script.yaml (editable)
         └─ GitHub / HN / Reddit + README and article text → research.json
```

Each stage writes its output to `episodes/<slug>/` and the next stage reads it
off disk, so you can stop after the script, edit the wording, and render.

## Quick start

```bash
cd /srv/environments/dev/video-studio
npm install && npx playwright install chromium   # one time

# Today's top 5 trending repos, end to end, no upload:
./bin/video-studio make --trending --count 5

# Same but stop after the script so you can edit the narration:
./bin/video-studio make --trending --count 5 --pause
./bin/video-studio render trending-daily-2026-09-19
./bin/video-studio publish trending-daily-2026-09-19 --visibility unlisted
```

`make` prints the final MP4 path (or the YouTube URL with `--publish`) on
stdout; everything else goes to stderr, so it composes in a shell pipeline.

## Queries

A query says what an episode is about. Use flags for a one-off:

```bash
./bin/video-studio make --trending rust --period weekly --count 5
./bin/video-studio make --search "topic:mcp stars:>300 pushed:>2026-06-01"
./bin/video-studio make --repos ggml-org/llama.cpp --name llama-cpp
./bin/video-studio make --hn "local llm" --points 200 --days 7
./bin/video-studio make --reddit selfhosted,homelab --count 4
```

…or save one as `queries/<name>.yaml` and run it by name:

```bash
./bin/video-studio queries                  # list saved queries
./bin/video-studio make -q trending-daily
```

Shipped examples: `trending-daily`, `trending-rust-weekly`, `mcp-servers`
(interest-driven GitHub search), `hn-ai-week`, `deep-dive` (single project),
`shorts-trending` (vertical 9:16).

```yaml
name: trending-daily
title: "Top {n} Trending GitHub Projects — {date}"   # {n} {date} {query}
count: 5
source:
  type: github_trending      # github_search | github_repos | hackernews | reddit
  period: daily              # daily | weekly | monthly
  language: rust             # optional
video:
  preset: landscape          # landscape (1920x1080) | shorts (1080x1920)
narration:
  voice: onyx                # any OpenAI TTS voice
script:
  tone: warm, dry, zero hype
  words_per_segment: 70
music:
  path: /path/to/bed.mp3     # optional; ducked under the narration
  volume: 0.12
youtube:
  upload: false              # or pass --publish
  visibility: unlisted
  tags: [github, trending]
```

## Editing an episode

`script.yaml` is the whole video in one file: every headline, bullet, stat
chip and line of narration, in playback order. Change anything, then
re-render only what changed:

```bash
./bin/video-studio render <slug> --only 2,3     # segment indices, 0-based
```

Narration audio is cached by (text + voice + model), so re-rendering a segment
whose words you didn't touch costs nothing and hits no API.

Useful edits:

- Reorder or delete a `segments:` entry to drop a subject.
- `broll:` is the list of shot prompts for that segment. Rewrite one and only
  that shot regenerates — prompts are content-addressed, so the others are
  reused from `.footage-cache` for free.
- Delete a segment's `broll:` and it falls back to a still card.
- Set `browse:` to nothing on a segment to show only its card.
- `browse.scrollSeconds` sets the floor for the scroll; the renderer always
  stretches it to cover the narration.
- `browse.highlights: ['article.markdown-body h1']` outlines elements in the
  accent colour.
- `browse.focus` is the selector the walkthrough scrolls to first
  (`article.markdown-body` by default on GitHub).

## Commands

| Command | What it does |
| --- | --- |
| `make` | All four stages. `--pause` stops after the script, `--publish` uploads. |
| `research` | Stage 1 → `research.json`. Prints the slug. |
| `script <slug>` | Stage 2 → `script.yaml`. `--force` rewrites, `--model`/`--tone` tune it. |
| `render <slug>` | Stage 3 → `<slug>.mp4`. `--only`, `--headed`, `--no-footage`. |
| `publish <slug>` | Stage 4 → YouTube. `--visibility`, `--title`, `--no-thumbnail`. |
| `episodes` | Every episode and how far it got. |
| `queries` | Saved queries. |
| `auth` | One-time YouTube sign-in. |

## Prerequisites

- **Node ≥ 22** (types are stripped at runtime — no build step).
- **ffmpeg** and **ffprobe** in PATH.
- **OPENAI_API_KEY** — writes the script, speaks it, and generates the b-roll.
  Already in `.env`. Video generation needs an account with access to the
  model in `OPENAI_VIDEO_MODEL` (`sora-2` by default); without it the render
  says so once and falls back to still cards.
- **YouTube OAuth client** — only for `publish`. `.env` already carries the
  client id/secret from `oauth-demo-recorder`, and that project's refresh
  token is reused automatically, so uploads work without re-authenticating.
  On a fresh machine: `./bin/video-studio auth`.
- **GitHub token** — optional. Unauthenticated GitHub API access is 60
  requests/hour; the sources fall back to `gh auth token` automatically, and
  `GITHUB_TOKEN` in `.env` overrides that.

Anything missing that you could just type is prompted for and written to
`.env`, rather than failing the run.

## Cards and footage

A segment's card used to be its own full-frame still — for a 5-item episode
that was 7 slides against 5 walkthroughs, and the majority of the cuts in the
video. Now the card is composited over moving footage instead:

1. The **hero** — the whole card, scrimmed so the shot still reads underneath
   — holds for about three seconds.
2. It dissolves, handing off to a **lower third** (eyebrow, headline, stat
   chips) that stays for the rest of the segment.
3. Nothing fades to black between clips. The footage runs straight into the
   next one.

The footage under it comes from a video model. The script writer produces two
shot prompts per segment alongside the narration, under a rule with an
explicit priority order: **creative** first (a metaphor with a point of view —
never a person at a keyboard, never a UI, never glowing code), **action**
second (something moves for the whole shot, and the prompt names both the
motion and the camera move), **relevant** third (the metaphor maps to what the
project actually does). Accuracy loses to interest on purpose — a safe prompt
is just a slide that moves.

The intro doesn't generate anything. It's cut from the b-roll the rest of the
episode already produced, so it teases the actual shots instead of listing the
lineup.

Knobs:

```yaml
video:
  cards: overlay        # or `full` for the old still slides
footage:
  enabled: true
  model: sora-2         # or $OPENAI_VIDEO_MODEL
  size: 1280x720        # defaults to the frame's orientation
  beat_seconds: 8       # 4, 8 or 12
```

`--cards full` and `--no-footage` do the same from the command line.
`--no-footage` only turns off the paid generation: the intro montage is cut
from footage already on disk, so it still runs.

Every fallback lands on a still card, loudly logged — a missing key, a model
this account can't reach, a moderation refusal, a dead network. The episode
never dies for want of b-roll.

## Cost per episode

Roughly, for a 5-item landscape episode: a handful of cents of `gpt-5.6-luna` for
the script, and `tts-1-hd` at $30 per million characters — about 4,000
characters of narration, so ~$0.12.

Footage is the expensive part. Each card buys at most three shots (capped at
~20 seconds of generated video), the intro is free, so a 5-item episode
generates roughly two minutes — at `sora-2`'s per-second rate that is dollars,
not cents, and it dominates everything else in this list. Check the current
price before scheduling this daily, and use `--no-footage` while you're
iterating on wording.

Generated shots are content-addressed by (model + size + seconds + prompt) in
`episodes/<slug>/.footage-cache`, so re-rendering a segment whose prompt you
didn't touch costs nothing, exactly like the TTS cache.

## Scheduling

Nothing is scheduled by default. To publish a daily roundup, add a cron entry:

```cron
# 07:15 every weekday — research, script, render and upload as unlisted
15 7 * * 1-5 cd /srv/environments/dev/video-studio && ./bin/video-studio make -q trending-daily --publish >> /var/log/video-studio.log 2>&1
```

Review the unlisted result before flipping `visibility` to `public` in the
query file.

## What it doesn't do

- No captions/subtitles track yet (YouTube's auto-captions handle it).
- No talking head, and no zoom-to-code-block choreography inside a
  walkthrough — a walkthrough is still one honest smooth scroll.
- Reddit and article fetching are best-effort: a subreddit that blocks the
  host is skipped with a warning rather than failing the episode.
- It won't tell you whether an episode is *good*. Watch it before publishing.
