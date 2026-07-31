---
description: Motion mode — turn a finished episode into a 16:9 single-file HTML info animation driven by an SRT master clock; built for playback and screen recording.
---

# Motion Mode (Info Animation)

Motion mode turns a finished episode (`script` + `script-timing` + `podcast.srt`) into a **16:9 (1920×1080) single-file HTML info animation**: every storyboard beat, step and the closing page is pinned to a real millisecond point, driven by the SRT master clock. It plays in any browser and is ready for screen recording.

The design is adapted from [jacky-motion](https://github.com/jackywxsz/jacky-motion) (MIT), keeping its "SRT master clock + confirmation gate" core, re-architected for BokeBox (deterministic storyboard, built-in dark editorial style, no LLM dependency).

## When to use

- Turn spoken content into a repeatable visual show (video accounts, podcast trailers, course clips)
- Record straight from OBS / QuickTime while the scene advances on the speech timeline
- Ship an offline, dependency-free, single-file animation

## Workflow

| Stage | What happens |
| --- | --- |
| **S1 Optimize SRT** | Read `podcast.srt` (fall back to `script-timing.json`), merge fragments, split overlong cues, repair overlaps, report coverage |
| **S2 Master clock** | Total duration = end of the last optimized cue; the whole timeline uses milliseconds as its single reference |
| **S3 Storyboard** | Outline segments → beats (boundaries pinned to anchor cue `startMs`); without an outline, split by character weight; last beat is the closing page |
| **S3.5 P3.5 gate** | Full-coverage check: first beat starts at 0ms, gaps ≤1500ms, no overlapping beats, step ms strictly increasing within the window, closing page aligns with the master clock (±300ms) |
| **S4 Assemble** | On gate pass, confirm the timeline (writes `motion-timeline.json`) and assemble the single-file `motion.html` |
| **S5 Static validation** | String-level re-check: beat count, millisecond points, monotonic steps, runtime markers, unique ids |

## Generate from the player

1. Open an episode (audio already synthesized)
2. Switch to the **Motion** panel
3. Click **Build storyboard (P3.5 precheck)** and review the coverage table: each beat's ms window, core text and step ms points
4. When the gate passes, click **Confirm timeline**, then **Download motion HTML**

Once confirmed, the timeline is locked (`motion-timeline.json`) and can be re-assembled any number of times without drifting when the pipeline is re-run.

## Storyboard & B-roll

- **motion beat**: information chapter page; title is a distilled short on-screen text (opening fillers stripped, shorter than the narration); steps reveal one by one following narration rhythm (2–5 steps), each pinned to the `startMs` of a semantic trigger cue
- **broll beat**: large silent gaps (≥1.5 s, common at paragraph breaks / music) first split the surrounding beats at a forced cut point, then are filled with a real broll transition page (large index number + preview title) so the picture never idles while narration pauses; the gate treats broll as a regular beat in coverage checks. Gaps under 1.5 s are normal narration pace and stay inside the beat (automated storyboarding does not split them)
- **closing beat**: the final recap page whose `endMs` hugs the master clock duration (±300 ms) and freezes on the last frame

## HTML player

- **Master clock**: `performance.now()` + `requestAnimationFrame`, no setTimeout chains; catches up by absolute time after a background tab
- **Gate overlay**: ready → 3-2-1 countdown (leave room before recording)
- **HUD**: beat dots + current millisecond clock
- **Keyboard**: `Space` pause/resume · `←` `→` ±5s · `R` restart · `F` fullscreen
- **Style**: deep navy background with indigo/cyan brand gradient (derived from the jobId), gold accent on the closing page; pure CSS transitions + class toggles, zero external dependencies

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/jobs/:id/motion/timeline` | Confirmed timeline & coverage (empty when none) |
| POST | `/api/jobs/:id/motion/draft` | S1→S3.5 precheck; returns coverage table and violations (no persistence) |
| POST | `/api/jobs/:id/motion/confirm` | Confirm timeline (422 when the gate fails) and assemble HTML |
| POST | `/api/jobs/:id/motion/build` | Re-assemble from the confirmed timeline |
| GET | `/api/jobs/:id/motion.html` | Download `motion.html` (`?download=1`) |
| GET | `/api/jobs/:id/motion.srt` | Download the optimized SRT |

Writes require a logged-in user; confirmed artifacts are downloadable by public-site visitors (same as audio).

## Artifacts

New files in the job directory:

- `motion-timeline.json` — the confirmed timeline (written only when the gate passes)
- `motion.html` — the single-file info animation

## Relation to jacky-motion

BokeBox's Motion mode is adapted from [jacky-motion](https://github.com/jackywxsz/jacky-motion) (MIT License); generated files keep the original author attribution in the file header. Adaptations:

- Removed the 6-stage LLM style selection; deterministic storyboard with one built-in dark editorial style
- Coverage table / gate rules aligned directly with BokeBox's millisecond TTS timeline
- Pure logic (parse / optimize / gate) lives in `@bokebox/shared`, shared by server and web to avoid rule drift
- B-roll implemented as "forced cut + fill": large silences first split the beat, then become broll pages, keeping the gate passable and the picture alive
- Gate gap limit relaxed from 500 ms to 1500 ms: automated storyboarding cannot fill gaps as finely as a human; TTS inter-sentence pauses up to ~1.5 s are normal narration pace; ≥1.5 s still forces a broll fill
