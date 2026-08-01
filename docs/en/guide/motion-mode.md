---
description: Motion mode — generate an AI-driven 16:9 page from the spoken script and preview it online against the SRT master clock.
---

# Motion Mode (Info Animation)

Motion turns a finished podcast episode into a **16:9 online information page**. The script stage first plans 2–3 primary chapters, and audio synthesis produces the measured SRT alongside the audio. AI designs one visual page per chapter; SRT / `script-timing` then advances the real narration clock inside each chapter.

The page is previewed directly inside the player. A single-file HTML download remains available as a secondary path for recording and offline sharing.

The design is adapted from [jacky-motion](https://github.com/Jackywxsz/Jacky-motion) (MIT), keeping its “SRT master clock + confirmation gate” core while reshaping the product flow for BokeBox.

The page generator also follows Jacky-motion's method: lock one style and information primitive first, then use a stable layout skeleton. Each scene has one clear first-glance object instead of a dashboard made of equal cards. Six styles are available: `apple-tech-gradient`, `editorial-magazine`, `sketch-note`, `finance-studio-cards`, `newspaper-evidence`, and `paper-collage`.

## Generate in the player

1. Generate or regenerate an episode; the pipeline produces a chaptered script, synthesized audio, and `podcast.srt` together.
2. Switch to the **Motion** panel.
3. Review the prepared 2–3 chapter cards; boundaries come from the script instead of being guessed from every subtitle cue.
4. Add a visual direction, for example “restrained like an Apple keynote, with three clear takeaways”.
5. Click **Generate page**. AI creates one visual page per fixed chapter, keeping the page count at 2–3.
6. Play the audio. Chapter changes and in-chapter steps follow the SRT in real time. Download HTML only when recording or sharing offline.

Without an LLM key, Motion creates a deterministic base page so preview still works. With an LLM configured, the visual content comes from the AI page generator.

## Workflow

| Stage | What happens |
| --- | --- |
| **S1 Chaptered script** | AI returns 2–3 `motionChapters` alongside `script`. Each chapter has a title, summary, and spoken fragment ready for TTS; the full script is the ordered chapter text joined with blank lines |
| **S2 Audio + SRT** | TTS synthesizes sentence chunks and writes measured `script-timing.json` and `podcast.srt` using speech ranges and pauses; Motion now has both its structure and real clock |
| **S3 Chapter timeline** | Map each chapter's opening sentence to a real SRT cue. Chapter windows absorb natural pauses, so page count does not grow with subtitle fragmentation |
| **S3.5 P3.5 gate** | Check that the first chapter starts at 0ms, chapters do not overlap, the closing chapter reaches the master duration, step ms values are valid, and the final beat is `closing` |
| **S4 AI page** | AI locks one style, layout skeleton, and information primitive for the fixed chapters; one primary page per chapter |
| **S5 Preview / export** | The React player switches between 2–3 pages in real time; `motion.html` remains available for recording |

## Generate from the player

The timeline is locked in `motion-timeline.json`; regenerating the AI page does not change the original script, audio, or SRT.

## Chapters & scenes

- **chapter beat**: a fixed chapter from the script stage, one page per chapter; title and summary are decided upstream, while step ms values come from the chapter's SRT cues
- **natural pauses**: sentence gaps stay inside the current chapter window instead of creating B-roll pages; long episodes do not produce dozens of subtitle cards
- **closing beat**: the final spoken chapter, whose `endMs` hugs the master clock duration (±300 ms) and freezes on the last frame

### Page and motion rules

- Information primitives are Claim, Contrast, Path, System, and Evidence; each beat chooses one primary primitive.
- Each chapter gets one primary visual page with only a few in-chapter reveals, and finishes on a screenshot-ready final frame.
- The style is locked for the episode; AI does not randomly change the visual language between adjacent scenes.

## HTML player

- **Master clock**: `performance.now()` + `requestAnimationFrame`, no setTimeout chains; catches up by absolute time after a background tab
- **Gate overlay**: ready → 3-2-1 countdown (leave room before recording)
- **HUD**: beat dots + current millisecond clock
- **Keyboard**: `Space` pause/resume · `←` `→` ±5s · `R` restart · `F` fullscreen
- **Style**: one locked style per episode; product-launch black space, editorial magazine, sketch note, finance studio, evidence newspaper, and paper collage are available; pure CSS transitions + class toggles, zero external dependencies

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/jobs/:id/motion/timeline` | Confirmed timeline & coverage (empty when none) |
| POST | `/api/jobs/:id/motion/generate` | Generate and save a page from the spoken script |
| POST | `/api/jobs/:id/motion/draft` | S1→S3.5 precheck; returns coverage table and violations (no persistence) |
| POST | `/api/jobs/:id/motion/confirm` | Confirm timeline (422 when the gate fails) and assemble HTML |
| POST | `/api/jobs/:id/motion/build` | Re-assemble from the confirmed timeline |
| GET | `/api/jobs/:id/motion.html` | Download `motion.html` (`?download=1`) |
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
- Page count is controlled by the 2–3 chapter plan, not by the number of subtitle cues
