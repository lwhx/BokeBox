import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { MotionPageSpec, MotionScene, MotionTimeline } from '@bokebox/shared/motion';
import {
  draftMotionTimeline,
  fetchMotionTimeline,
  generateMotionPage,
  motionSrtUrl,
  motionTimelineUrl,
} from '../../api/motion';
import { useI18n } from '../../i18n';
import { getToken } from '../../lib/auth';

type Phase =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; timeline: MotionTimeline }
  | { kind: 'error'; message: string };

function timelineFromDraft(jobId: string, draft: Awaited<ReturnType<typeof draftMotionTimeline>>): MotionTimeline {
  return {
    version: 1,
    jobId,
    title: draft.title,
    durationMs: draft.durationMs,
    source: 'srt',
    srtCueCount: draft.srtInfo?.rawCues || draft.beats.length,
    optimizedCueCount: draft.srtInfo?.optimizedCues || draft.beats.length,
    beats: draft.beats,
  };
}

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fallbackScene(beat: MotionTimeline['beats'][number], index: number): MotionScene {
  const primitive = beat.kind === 'closing'
    ? 'Claim'
    : beat.stepLabels?.length && beat.stepLabels.length > 1
      ? 'Path'
      : 'Claim';
  return {
    beatId: beat.id,
    layout: beat.kind === 'closing' ? 'closing' : index === 0 ? 'hero' : 'split',
    primitive,
    visual: beat.kind === 'closing' ? 'quote-lock' : primitive === 'Path' ? 'path-build' : 'claim-lockup',
    eyebrow: beat.kind === 'closing' ? 'TAKEAWAY' : `PART ${String(index + 1).padStart(2, '0')}`,
    title: beat.title,
    body: '',
    bullets: beat.stepLabels || [],
    accent: ['#8b5cf6', '#22d3ee', '#f59e0b', '#f472b6'][index % 4],
  };
}

function resolveScene(
  page: MotionPageSpec | undefined,
  beat: MotionTimeline['beats'][number],
  index: number,
): MotionScene {
  const fallback = fallbackScene(beat, index);
  const stored = page?.scenes.find((item) => item.beatId === beat.id) as Partial<MotionScene> | undefined;
  return {
    ...fallback,
    ...stored,
    primitive: stored?.primitive || fallback.primitive,
    visual: stored?.visual || fallback.visual,
  };
}

function MotionVisualGraphic({ scene }: { scene: MotionScene }) {
  const bullets = scene.bullets.slice(0, 4);
  if (scene.visual === 'path-build') {
    return (
      <div className="qq-motion-live-path">
        {bullets.map((item, index) => (
          <div className="qq-motion-live-path-item" key={`${item}-${index}`}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{item}</strong>
            {index < bullets.length - 1 && <i aria-hidden />}
          </div>
        ))}
      </div>
    );
  }
  if (scene.visual === 'split-compare') {
    return (
      <div className="qq-motion-live-split">
        <div><small>BEFORE</small><strong>{bullets[0] || '原来的做法'}</strong></div>
        <i aria-hidden />
        <div className="is-focus"><small>AFTER</small><strong>{bullets[1] || scene.title}</strong></div>
      </div>
    );
  }
  if (scene.visual === 'system-layer-expand') {
    return (
      <div className="qq-motion-live-layers">
        {bullets.slice(0, 3).map((item, index) => <div key={`${item}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item}</strong></div>)}
      </div>
    );
  }
  if (scene.visual === 'number-count') {
    return <div className="qq-motion-live-number"><strong>{String(bullets.length || 1).padStart(2, '0')}</strong><span>KEY POINTS</span></div>;
  }
  if (scene.visual === 'quote-lock') {
    return <blockquote className="qq-motion-live-quote">{scene.body || scene.title}</blockquote>;
  }
  return <div className="qq-motion-live-lockup"><i aria-hidden /><span>{scene.primitive}</span></div>;
}

function MotionPreview({
  timeline,
  currentSec,
  durationSec,
  playing,
  onSeek,
}: {
  timeline: MotionTimeline;
  currentSec: number;
  durationSec: number;
  playing: boolean;
  onSeek: (sec: number) => void;
}) {
  const nowMs = Math.max(0, currentSec * 1000);
  const activeIndex = Math.max(
    0,
    timeline.beats.findIndex((beat, index) => {
      const next = timeline.beats[index + 1];
      return nowMs >= beat.startMs && (!next || nowMs < next.startMs);
    }),
  );
  const beat = timeline.beats[activeIndex] || timeline.beats[0];
  const page: MotionPageSpec | undefined = timeline.page;
  const scene = resolveScene(page, beat, activeIndex);
  const style = page?.style || 'editorial-magazine';
  const totalSec = durationSec > 0 ? durationSec : timeline.durationMs / 1000;
  const progress = totalSec > 0 ? Math.min(100, (currentSec / totalSec) * 100) : 0;
  const activeStep = beat
    ? Math.min(
        scene.bullets.length,
        1 + beat.stepTimes.filter((time) => time <= nowMs).length,
      )
    : 1;
  const visibleScene = scene.bullets.length > 0
    ? { ...scene, bullets: scene.bullets.slice(0, Math.max(1, activeStep)) }
    : scene;

  return (
    <div className={['qq-motion-preview', playing ? 'is-playing' : ''].join(' ')}>
      <div className={['qq-motion-canvas', `motion-style-${style}`].join(' ')} style={{ '--motion-accent': scene.accent } as CSSProperties}>
        <div className="qq-motion-canvas-grid" aria-hidden />
        <div className="qq-motion-canvas-top">
          <span>{scene.eyebrow}</span>
          <span>{fmtMs(nowMs)} / {fmtMs(timeline.durationMs)}</span>
        </div>
        <div className={['qq-motion-scene', `is-${visibleScene.layout}`, `is-${visibleScene.visual}`].join(' ')}>
          <div className="qq-motion-scene-index">{String(activeIndex + 1).padStart(2, '0')}</div>
          <div className="qq-motion-scene-copy">
            <h4>{visibleScene.title}</h4>
            {visibleScene.body && <p>{visibleScene.body}</p>}
            <MotionVisualGraphic scene={visibleScene} />
          </div>
        </div>
        <div className="qq-motion-canvas-footer">
          <span>{page?.source === 'ai' ? `AI · ${style}` : `MOTION · ${style}`}</span>
          <span>{timeline.title}</span>
        </div>
      </div>
      <div className="qq-motion-scrubber">
        <div className="qq-motion-scrubber-track" aria-hidden>
          {timeline.beats.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={index === activeIndex ? 'is-active' : ''}
              style={{ left: `${timeline.durationMs ? (item.startMs / timeline.durationMs) * 100 : 0}%`, width: `${timeline.durationMs ? ((item.endMs - item.startMs) / timeline.durationMs) * 100 : 0}%` }}
              onClick={() => onSeek(item.startMs / 1000)}
              aria-label={`${item.title} ${fmtMs(item.startMs)}`}
            />
          ))}
          <i style={{ width: `${progress}%` }} />
        </div>
        <div className="qq-motion-scrubber-labels">
          <span>{fmtMs(nowMs)}</span>
          <span>{timeline.beats.length} scenes · {page?.source === 'ai' ? 'AI page' : 'ready'}</span>
          <span>{fmtMs(timeline.durationMs)}</span>
        </div>
      </div>
    </div>
  );
}

export function MotionPanel({
  jobId,
  currentSec = 0,
  durationSec = 0,
  playing = false,
  onSeek = () => undefined,
}: {
  jobId: string;
  currentSec?: number;
  durationSec?: number;
  playing?: boolean;
  onSeek?: (sec: number) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const loggedIn = Boolean(getToken());

  const load = useCallback(async () => {
    const result = await fetchMotionTimeline(jobId);
    if (result.hasTimeline && result.timeline) setPhase({ kind: 'ready', timeline: result.timeline });
    else if (loggedIn) {
      const draft = await draftMotionTimeline(jobId);
      if (draft.ok && draft.gate?.pass && draft.beats.length) {
        setPhase({ kind: 'ready', timeline: timelineFromDraft(jobId, draft) });
      } else {
        setPhase({ kind: 'idle' });
      }
    } else setPhase({ kind: 'idle' });
  }, [jobId, loggedIn]);

  useEffect(() => {
    void load().catch(() => setPhase({ kind: 'error', message: t('motion.error') }));
  }, [load, t]);

  const generate = async () => {
    setBusy(true);
    setPhase({ kind: 'generating' });
    try {
      const result = await generateMotionPage(jobId, prompt);
      if (!result.ok || !result.timeline) throw new Error(result.message || result.error || t('motion.error'));
      setPhase({ kind: 'ready', timeline: result.timeline });
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const timeline = phase.kind === 'ready' ? phase.timeline : null;
  const activeLabel = useMemo(() => {
    if (!timeline) return '';
    const ms = currentSec * 1000;
    return timeline.beats.find((beat, index) => {
      const next = timeline.beats[index + 1];
      return ms >= beat.startMs && (!next || ms < next.startMs);
    })?.title || timeline.beats[0]?.title || '';
  }, [currentSec, timeline]);
  const activeBeatIndex = timeline
    ? Math.max(0, timeline.beats.findIndex((beat, index) => {
        const next = timeline.beats[index + 1];
        const nowMs = currentSec * 1000;
        return nowMs >= beat.startMs && (!next || nowMs < next.startMs);
      }))
    : -1;

  return (
    <div className="qq-motion">
      <header className="qq-motion-header">
        <div>
          <div className="qq-motion-kicker">{t('motion.kicker')}</div>
          <h3 className="qq-motion-title">{t('motion.title')}</h3>
          <p className="qq-motion-desc">{t('motion.desc')}</p>
        </div>
        <div className="qq-motion-status"><i />{timeline ? timeline.page ? t('motion.previewReady') : t('motion.planReady') : t('motion.notGenerated')}</div>
      </header>

      <section className="qq-motion-create">
        <div className="qq-motion-create-copy">
          <span className="qq-motion-create-number">01</span>
          <div>
            <strong>{timeline?.page ? t('motion.createTitle') : t('motion.planTitle')}</strong>
            <p>{timeline?.page ? t('motion.createDesc') : t('motion.planDesc')}</p>
          </div>
        </div>
        <div className="qq-motion-prompt-row">
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('motion.promptPlaceholder')}
            disabled={!loggedIn || busy}
          />
          <button type="button" className="qq-btn is-primary" onClick={generate} disabled={!loggedIn || busy}>
            {busy ? t('motion.generating') : timeline?.page ? t('motion.regenerate') : t('motion.generate')}
          </button>
        </div>
        {timeline && !timeline.page && (
          <div className="qq-motion-plan-strip">
            <span>{t('motion.planStats', { n: timeline.beats.length })}</span>
            <span>{timeline.beats.map((beat) => beat.title).join(' / ')}</span>
          </div>
        )}
        {!loggedIn && <p className="qq-motion-login-hint">{t('motion.loginHint')}</p>}
      </section>

      {phase.kind === 'error' && <div className="qq-motion-error">{phase.message}</div>}
      {phase.kind === 'generating' && (
        <div className="qq-motion-loading"><span /><span /><span />{t('motion.generatingHint')}</div>
      )}

      {timeline && (
        <>
          <section className="qq-motion-preview-card">
            <div className="qq-motion-preview-head">
              <div>
                <span className="qq-motion-section-kicker">02 · LIVE PREVIEW</span>
                <strong>{activeLabel}</strong>
              </div>
              <span>{timeline.page?.source === 'ai' ? t('motion.aiGenerated') : t('motion.fallbackGenerated')}</span>
            </div>
            <MotionPreview
              timeline={timeline}
              currentSec={currentSec}
              durationSec={durationSec}
              playing={playing}
              onSeek={onSeek}
            />
          </section>

          <section className="qq-motion-scenes">
            <div className="qq-motion-scenes-head">
              <div>
                <span className="qq-motion-section-kicker">03 · SCRIPT MAP</span>
                <strong>{t('motion.scenesTitle')}</strong>
              </div>
              <div className="qq-motion-scene-actions">
                <a href={motionSrtUrl(jobId)}>{t('motion.downloadSrt')}</a>
                {timeline.page && <a href={motionTimelineUrl(jobId, true)} download>{t('motion.downloadHtml')}</a>}
              </div>
            </div>
            <div className="qq-motion-scene-list">
              {timeline.beats.map((beat, index) => {
                const scene = resolveScene(timeline.page, beat, index);
                return (
                  <button key={beat.id} type="button" onClick={() => onSeek(beat.startMs / 1000)} className={index === activeBeatIndex ? 'is-current' : ''}>
                    <span className="qq-motion-scene-list-time">{fmtMs(beat.startMs)}</span>
                    <span className="qq-motion-scene-list-copy"><small>{scene.eyebrow} · {scene.primitive} · {scene.visual}</small><strong>{scene.title}</strong></span>
                    <span className="qq-motion-scene-list-arrow">↗</span>
                  </button>
                );
              })}
            </div>
          </section>
        </>
      )}

      {!timeline && phase.kind === 'idle' && <div className="qq-motion-empty"><span>✦</span><strong>{t('motion.emptyTitle')}</strong><p>{t('motion.emptyDesc')}</p></div>}
    </div>
  );
}
