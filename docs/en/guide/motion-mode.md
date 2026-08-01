---
description: Motion mode — generate a recordable 16:9 multi-composition animation from the spoken script and sync it to the SRT master clock.
---

# Motion Mode (Info Animation)

Motion turns a finished podcast episode into a **16:9 recordable information animation**. The script's actual length and natural paragraphs drive the chapter and animation count, while audio synthesis produces the measured SRT alongside the audio. AI composes an independent HTML layout and entrance rhythm for every animation interval; SRT / `script-timing` advances the real narration clock.

The page is previewed directly inside the player, or opened as a new standalone page that loads the job audio for full-screen recording; visuals and audio share the SRT master clock. A single-file HTML download remains available for offline visual sharing.

The design is adapted from [jacky-motion](https://github.com/Jackywxsz/Jacky-motion) (MIT), keeping its “SRT master clock + confirmation gate” core while reshaping the product flow for BokeBox.

The page generator keeps Jacky-motion's SRT clock idea but no longer locks the episode into one layout skeleton. It locks a color base for the episode, then gives every beat its own composition and motion. Eight compositions are available: hook slam, diagonal reveal, signal bars, before/after, stack cascade, quote cut, ticker drive, and closing lock. Each scene has one clear first-glance object instead of a dashboard made of equal cards.

## Generate in the player

1. Generate or regenerate an episode; the pipeline produces a chaptered script, synthesized audio, and `podcast.srt` together.
2. Switch to the **Motion** panel.
3. Review the prepared chapter cards; their count grows with the spoken script instead of being fixed or guessed from every subtitle cue.
4. Add a visual direction, for example “restrained like an Apple keynote, with three clear takeaways”.
5. Click **Generate page**. AI creates one visual page for every script-driven animation interval, so longer scripts produce more scenes.
6. Play the audio. Chapter changes and in-chapter steps follow the SRT in real time. Open **Open recording page** for a standalone full-screen HTML page, or download it for offline sharing.

Without an LLM key, Motion still creates a deterministic multi-composition page so preview and recording work. With an LLM configured, the visual content comes from the AI page generator.

## Workflow

| Stage | What happens |
| --- | --- |
| **S1 Chaptered script** | AI returns `motionChapters` alongside `script`. Roughly 220 spoken characters are used as a guide per chapter; short scripts keep at least 2, while longer scripts add chapters as needed. Each chapter has a title, summary, and spoken fragment ready for TTS; the full script is the ordered chapter text joined with blank lines |
| **S2 Audio + SRT** | TTS synthesizes sentence chunks and writes measured `script-timing.json` and `podcast.srt` using speech ranges and pauses; Motion now has both its structure and real clock |
| **S3 Chapter timeline** | Map each chapter's opening sentence to a real SRT cue. Chapter windows absorb natural pauses, so page count does not grow with subtitle fragmentation |
| **S3.5 P3.5 gate** | Check that the first chapter starts at 0ms, chapters do not overlap, the closing chapter reaches the master duration, step ms values are valid, and the final beat is `closing` |
| **S4 AI page** | AI chooses an independent composition and entrance motion for every script-driven interval; the episode shares only a color base |
| **S5 Preview / export** | The React player switches between all generated pages in real time; a standalone `motion.html` opens with the job audio for full-screen recording, while the HTML download remains an offline visual artifact |

## Generate from the player

The timeline is locked in `motion-timeline.json`; regenerating the AI page does not change the original script, audio, or SRT.

## Chapters & scenes

- **chapter beat**: a semantic chapter from the script stage, subdivided by spoken length into animation intervals; titles and summaries come from upstream, while step ms values come from the interval's SRT cues
- **natural pauses**: normal sentence gaps stay inside chapter windows; pauses beyond the gate threshold still receive a B-roll transition so the visual does not sit empty
- **closing beat**: the final spoken chapter, whose `endMs` hugs the master clock duration (±300 ms) and freezes on the last frame

### Page and motion rules

- Information primitives are Claim, Contrast, Path, System, and Evidence; each beat chooses one primary primitive.
- Each chapter gets one primary visual page with only a few in-chapter reveals, and finishes on a screenshot-ready final frame.
- The color base is locked for the episode, while composition and entrance motion are selected per beat; adjacent pages do not repeat the same composition.
- Titles, supporting text, and visual marks stay inside recording-safe margins instead of collapsing into a card wall.

## HTML player

- **Master clock**: `performance.now()` + `requestAnimationFrame`, no setTimeout chains; catches up by absolute time after a background tab
- **Gate overlay**: ready → 3-2-1 countdown (leave room before recording)
- **Audio**: the standalone page first tries to autoplay the job audio; when the browser blocks it, the visual preview still runs and a bottom button enables sound after a user click; pause, seek, and replay re-align the audio
- **HUD**: beat dots + current millisecond clock
- **Keyboard**: `Space` pause/resume · `←` `→` ±5s · `R` restart · `F` fullscreen
- **Style**: the color base can use product-launch black space, editorial magazine, sketch note, finance studio, evidence newspaper, or paper collage; each beat adds its own composition and entrance motion with pure CSS animation and class toggles, zero external dependencies

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/jobs/:id/motion/timeline` | Confirmed timeline & coverage (empty when none) |
| POST | `/api/jobs/:id/motion/generate` | Generate and save a page from the spoken script |
| POST | `/api/jobs/:id/motion/draft` | S1→S3.5 precheck; returns coverage table and violations (no persistence) |
| POST | `/api/jobs/:id/motion/confirm` | Confirm timeline (422 when the gate fails) and assemble HTML |
| POST | `/api/jobs/:id/motion/build` | Re-assemble from the confirmed timeline |
| GET | `/api/jobs/:id/motion.html` | Open the standalone `motion.html`; add `?download=1` to download |
| GET | `/api/jobs/:id/motion.srt` | Download the optimized SRT |

Writes require a logged-in user; confirmed artifacts are downloadable by public-site visitors (same as audio).

## Artifacts

New files in the job directory:

- `motion-timeline.json` — the timeline plus AI page spec (written only when the gate passes)
- `motion.html` — the single-file info animation

## Relation to jacky-motion

BokeBox's Motion mode is adapted from [jacky-motion](https://github.com/jackywxsz/jacky-motion) (MIT License); generated files keep the original author attribution in the file header. Adaptations:

- Keep the SRT master clock and confirmation gate, but make page content AI-driven by the spoken script
- Make online preview the primary path and HTML download secondary
- Use a deterministic fallback page when no LLM is configured so preview is never blocked
- Coverage table / gate rules aligned directly with BokeBox's millisecond TTS timeline
- Pure logic (parse / optimize / gate) lives in `@bokebox/shared`, shared by server and web to avoid rule drift
- Chapters are fixed upstream while the spoken script is generated, so Motion does not reverse-engineer page structure after audio is complete
- Audio synthesis writes the real `podcast.srt`; Motion does not need a public download request to recover timing on demand
- Page count is derived from spoken characters, natural paragraphs, and alignable SRT cues. Roughly 220 spoken characters form one visual interval, subject to cue availability and a safety ceiling; it is not fixed at 2–3 pages.
