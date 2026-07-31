---
description: Motion mode — generate an AI-driven 16:9 page from the spoken script and preview it online against the SRT master clock.
---

# Motion Mode (Info Animation)

Motion turns a finished podcast episode into a **16:9 online information page**. AI reads the spoken script and outline to create the visual hierarchy, short titles, bullets, and layouts. SRT / `script-timing` remains the single master clock so every scene follows the real narration.

The page is previewed directly inside the player. A single-file HTML download remains available as a secondary path for recording and offline sharing.

The design is adapted from [jacky-motion](https://github.com/Jackywxsz/Jacky-motion) (MIT), keeping its “SRT master clock + confirmation gate” core while reshaping the product flow for BokeBox.

The page generator also follows Jacky-motion's method: lock one style and information primitive first, then use a stable layout skeleton. Each scene has one clear first-glance object instead of a dashboard made of equal cards. Six styles are available: `apple-tech-gradient`, `editorial-magazine`, `sketch-note`, `finance-studio-cards`, `newspaper-evidence`, and `paper-collage`.

## Generate in the player

1. Open an episode with synthesized audio and a spoken script.
2. Switch to the **Motion** panel.
3. Add a visual direction, for example “restrained like an Apple keynote, with three clear takeaways”.
4. Click **Generate page**. AI reads the script, outline, and fixed timeline.
5. Play the audio. The page preview, scrubber, and scene list follow it in real time.
6. Click a scene card to seek. Download HTML only when recording or sharing offline.

Without an LLM key, Motion creates a deterministic base page so preview still works. With an LLM configured, the visual content comes from the AI page generator.

## Workflow

| Stage | What happens |
| --- | --- |
| **S1 Optimize SRT** | Read `podcast.srt`; fall back to `script-timing.json` or embedded job timing, and recover timing from existing audio plus the spoken script when needed; then merge fragments, split overlong cues, repair overlaps, and report coverage |
| **S2 Master clock** | Total duration = end of the last optimized cue; the whole timeline uses milliseconds as its single reference |
| **S3 Storyboard** | Outline segments → beats (boundaries pinned to anchor cue `startMs`); without an outline, split by character weight; last beat is the closing page |
| **S3.5 P3.5 gate** | Full-coverage check: first beat starts at 0ms, gaps ≤1500ms, no overlapping beats, step ms strictly increasing within the window, closing page aligns with the master clock (±300ms) |
| **S4 AI page** | AI locks the style, layout skeleton, and information primitive before filling the visual layer |
| **S5 Preview / export** | The React player follows audio in real time; `motion.html` remains available for recording |

## Generate from the player

The timeline is locked in `motion-timeline.json`; regenerating the AI page does not change the original script, audio, or SRT.

## Storyboard & B-roll

- **motion beat**: information chapter page; title is a distilled short on-screen text (opening fillers stripped, shorter than the narration); steps reveal one by one following narration rhythm (2–5 steps), each pinned to the `startMs` of a semantic trigger cue
- **broll beat**: large silent gaps (≥1.5 s, common at paragraph breaks / music) first split the surrounding beats at a forced cut point, then are filled with a real broll transition page (large index number + preview title) so the picture never idles while narration pauses; the gate treats broll as a regular beat in coverage checks. Gaps under 1.5 s are normal narration pace and stay inside the beat (automated storyboarding does not split them)
- **closing beat**: the final recap page whose `endMs` hugs the master clock duration (±300 ms) and freezes on the last frame

### Page and motion rules

- Information primitives are Claim, Contrast, Path, System, and Evidence; each beat chooses one primary primitive.
- Core beats use the four-part camera language `glance → reconstruct → push → lock` and finish on a screenshot-ready final frame.
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
- B-roll implemented as "forced cut + fill": large silences first split the beat, then become broll pages, keeping the gate passable and the picture alive
- Gate gap limit relaxed from 500 ms to 1500 ms: automated storyboarding cannot fill gaps as finely as a human; TTS inter-sentence pauses up to ~1.5 s are normal narration pace; ≥1.5 s still forces a broll fill
