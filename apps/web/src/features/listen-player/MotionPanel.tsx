import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { MotionPageSpec, MotionScene, MotionTimeline } from '@bokebox/shared/motion';
import {
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

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fallbackScene(beat: MotionTimeline['beats'][number], index: number): MotionScene {
  return {
    beatId: beat.id,
    layout: beat.kind === 'closing' ? 'closing' : index === 0 ? 'hero' : 'split',
    eyebrow: beat.kind === 'closing' ? 'TAKEAWAY' : `PART ${String(index + 1).padStart(2, '0')}`,
    title: beat.title,
    body: '',
    bullets: beat.stepLabels || [],
    accent: ['#8b5cf6', '#22d3ee', '#f59e0b', '#f472b6'][index % 4],
  };
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
  const scene = page?.scenes.find((item) => item.beatId === beat?.id) || fallbackScene(beat, activeIndex);
  const totalSec = durationSec > 0 ? durationSec : timeline.durationMs / 1000;
  const progress = totalSec > 0 ? Math.min(100, (currentSec / totalSec) * 100) : 0;

  return (
    <div className={['qq-motion-preview', playing ? 'is-playing' : ''].join(' ')}>
      <div className="qq-motion-canvas" style={{ '--motion-accent': scene.accent } as CSSProperties}>
        <div className="qq-motion-canvas-grid" aria-hidden />
        <div className="qq-motion-canvas-top">
          <span>{scene.eyebrow}</span>
          <span>{fmtMs(nowMs)} / {fmtMs(timeline.durationMs)}</span>
        </div>
        <div className={['qq-motion-scene', `is-${scene.layout}`].join(' ')}>
          <div className="qq-motion-scene-index">{String(activeIndex + 1).padStart(2, '0')}</div>
          <div className="qq-motion-scene-copy">
            <h4>{scene.title}</h4>
            {scene.body && <p>{scene.body}</p>}
            {scene.bullets.length > 0 && (
              <div className="qq-motion-scene-bullets">
                {scene.bullets.map((bullet, index) => <span key={`${bullet}-${index}`}>{bullet}</span>)}
              </div>
            )}
          </div>
          <div className="qq-motion-orbit" aria-hidden><i /><i /><i /></div>
        </div>
        <div className="qq-motion-canvas-footer">
          <span>{page?.source === 'ai' ? 'AI GENERATED PAGE' : 'MOTION PAGE'}</span>
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
    else setPhase({ kind: 'idle' });
  }, [jobId]);

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
        <div className="qq-motion-status"><i />{timeline ? t('motion.previewReady') : t('motion.notGenerated')}</div>
      </header>

      <section className="qq-motion-create">
        <div className="qq-motion-create-copy">
          <span className="qq-motion-create-number">01</span>
          <div>
            <strong>{t('motion.createTitle')}</strong>
            <p>{t('motion.createDesc')}</p>
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
            {busy ? t('motion.generating') : timeline ? t('motion.regenerate') : t('motion.generate')}
          </button>
        </div>
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
                <a href={motionTimelineUrl(jobId, true)} download>{t('motion.downloadHtml')}</a>
              </div>
            </div>
            <div className="qq-motion-scene-list">
              {timeline.beats.map((beat, index) => {
                const scene = timeline.page?.scenes.find((item) => item.beatId === beat.id) || fallbackScene(beat, index);
                return (
                  <button key={beat.id} type="button" onClick={() => onSeek(beat.startMs / 1000)} className={index === activeBeatIndex ? 'is-current' : ''}>
                    <span className="qq-motion-scene-list-time">{fmtMs(beat.startMs)}</span>
                    <span className="qq-motion-scene-list-copy"><small>{scene.eyebrow} · {scene.layout}</small><strong>{scene.title}</strong></span>
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
