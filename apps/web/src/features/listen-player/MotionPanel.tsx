import { useCallback, useEffect, useState } from 'react';
import type {
  CoverageRow,
  GateResult,
  MotionTimeline,
} from '@bokebox/shared/motion';
import {
  confirmMotionTimeline,
  draftMotionTimeline,
  fetchMotionTimeline,
  motionSrtUrl,
  motionTimelineUrl,
  rebuildMotionHtml,
  type MotionDraftResponse,
} from '../../api/motion';
import { useI18n } from '../../i18n';
import { getToken } from '../../lib/auth';
import { ApiError } from '../../api/http';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; draft: MotionDraftResponse }
  | { kind: 'confirmed'; timeline: MotionTimeline }
  | { kind: 'error'; message: string; gate?: GateResult | null; rows?: CoverageRow[] };

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  const mmm = String(Math.max(0, Math.round(ms)) % 1000).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

function gateSummary(gate: GateResult | null): { ok: boolean; text: string } {
  if (!gate) return { ok: false, text: '—' };
  if (gate.pass) {
    return {
      ok: true,
      text: `通过 · ${gate.rows.length} 个分镜 · 全覆盖 ${fmtMs(gate.coverageMs)}`,
    };
  }
  const codes = gate.violations
    .map((v) => {
      switch (v.code) {
        case 'first-beat-not-zero':
          return '首镜未从 0ms 开始';
        case 'beat-overlap':
          return '分镜重叠';
        case 'beat-gap':
          return '空档超 500ms';
        case 'step-out-of-range':
          return '步骤毫秒点越界';
        case 'step-not-monotonic':
          return '步骤毫秒点未递增';
        case 'closing-not-at-end':
          return '收束页未贴合主时钟';
        case 'empty-beat':
          return '存在空分镜';
        default:
          return v.code;
      }
    })
    .filter(Boolean);
  return { ok: false, text: `未通过：${[...new Set(codes)].join(' · ')}` };
}

export function MotionPanel({ jobId }: { jobId: string }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const loadConfirmed = useCallback(async () => {
    const res = await fetchMotionTimeline(jobId);
    if (res.hasTimeline && res.timeline) {
      setPhase({ kind: 'confirmed', timeline: res.timeline });
      return true;
    }
    return false;
  }, [jobId]);

  useEffect(() => {
    void loadConfirmed().catch(() => setPhase({ kind: 'error', message: t('motion.error') }));
  }, [loadConfirmed, t]);

  const runDraft = async () => {
    setBusy(true);
    try {
      const draft = await draftMotionTimeline(jobId);
      if (!draft.ok) {
        setPhase({ kind: 'error', message: draft.message || t('motion.gateFailed'), gate: draft.gate });
      } else {
        setPhase({ kind: 'ready', draft });
      }
    } catch (e) {
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        gate: e instanceof ApiError ? (e.data as { gate?: GateResult | null } | undefined)?.gate ?? null : null,
        rows: e instanceof ApiError ? (e.data as { rows?: CoverageRow[] } | undefined)?.rows : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (phase.kind !== 'ready') return;
    setBusy(true);
    try {
      const res = await confirmMotionTimeline(jobId, phase.draft.beats);
      if (res.ok && res.timeline) {
        setPhase({ kind: 'confirmed', timeline: res.timeline });
      } else {
        setPhase({ kind: 'error', message: res.message || res.error || t('motion.gateFailed') });
      }
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async () => {
    setBusy(true);
    try {
      const res = await rebuildMotionHtml(jobId);
      if (res.ok && res.timeline) {
        setPhase({ kind: 'confirmed', timeline: res.timeline });
      } else {
        setPhase({ kind: 'error', message: res.message || res.error || t('motion.error') });
      }
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const draft = phase.kind === 'ready' ? phase.draft : null;
  const gate = draft?.gate ?? null;
  const summary = gateSummary(gate);
  const loggedIn = Boolean(getToken());

  return (
    <div className="qq-motion">
      <div className="qq-motion-head">
        <div>
          <div className="qq-motion-kicker">{t('motion.kicker')}</div>
          <h3 className="qq-motion-title">{t('motion.title')}</h3>
          <p className="qq-motion-desc">{t('motion.desc')}</p>
        </div>
        {loggedIn && phase.kind === 'idle' && (
          <button
            type="button"
            className="qq-btn"
            onClick={runDraft}
            disabled={busy}
          >
            {busy ? t('common.loading') : t('motion.draft')}
          </button>
        )}
        {loggedIn && phase.kind === 'ready' && !gate?.pass && (
          <button type="button" className="qq-btn" onClick={runDraft} disabled={busy}>
            {t('common.refresh')}
          </button>
        )}
      </div>

      {phase.kind === 'error' && (
        <>
          <p className="qq-motion-error">{phase.message}</p>
          {phase.gate && (
            <>
              <div className="qq-motion-gate is-fail">
                <span className="qq-motion-gate-dot" />
                {gateSummary(phase.gate).text}
              </div>
              {phase.gate.violations.length > 0 && (
                <ul className="qq-motion-notes">
                  {phase.gate.violations.map((v, i) => (
                    <li key={i}>{v.message}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {phase.rows && phase.rows.length > 0 && <MotionCoverageTable rows={phase.rows} />}
        </>
      )}

      {phase.kind === 'confirmed' && (
        <div className="qq-motion-gate is-pass">
          <span className="qq-motion-gate-dot" />
          {t('motion.confirmed')}
        </div>
      )}

      {draft && (
        <>
          <div className={`qq-motion-gate ${gate?.pass ? 'is-pass' : 'is-fail'}`}>
            <span className="qq-motion-gate-dot" />
            {summary.text}
          </div>

          {draft.srtInfo && (
            <div className="qq-motion-meta">
              <span>
                {t('motion.srtSource')}: {draft.srtInfo.source}
              </span>
              <span>
                {draft.srtInfo.rawCues} → {draft.srtInfo.optimizedCues} {t('motion.cues')}
              </span>
              <span>Σ {fmtMs(draft.srtInfo.durationMs)}</span>
              <a
                href={motionSrtUrl(jobId)}
                className="qq-motion-link"
                title={t('motion.downloadSrt')}
              >
                SRT
              </a>
            </div>
          )}

          {draft.notes?.length > 0 && (
            <ul className="qq-motion-notes">
              {draft.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}

          <MotionCoverageTable rows={draft.rows} />
        </>
      )}

      {phase.kind === 'ready' && gate?.pass && (
        <div className="qq-motion-actions">
          <button type="button" className="qq-btn is-primary" onClick={confirm} disabled={busy}>
            {t('motion.confirm')}
          </button>
        </div>
      )}

      {phase.kind === 'confirmed' && (
        <>
          <MotionCoverageTable rows={phase.timeline.beats} />
          <div className="qq-motion-actions">
            {loggedIn && (
              <button type="button" className="qq-btn" onClick={rebuild} disabled={busy}>
                {t('motion.rebuild')}
              </button>
            )}
            <a
              href={motionTimelineUrl(jobId, true)}
              className="qq-btn is-primary"
              download
            >
              {t('motion.downloadHtml')}
            </a>
          </div>
        </>
      )}

      {phase.kind === 'idle' && !loggedIn && (
        <p className="qq-motion-error">{t('motion.loginHint')}</p>
      )}
    </div>
  );
}

function MotionCoverageTable({ rows }: { rows: Array<CoverageRow | MotionTimeline['beats'][number]> }) {
  const { t } = useI18n();
  return (
    <table className="qq-motion-table">
      <thead>
        <tr>
          <th>{t('motion.colBeat')}</th>
          <th>{t('motion.colKind')}</th>
          <th>{t('motion.colWindow')}</th>
          <th>{t('motion.colCore')}</th>
          <th>{t('motion.colSteps')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const beatId = 'beatId' in row ? row.beatId : row.id;
          const core = 'core' in row ? row.core : row.title;
          return (
            <tr key={beatId}>
              <td className="qq-motion-td-id">{beatId}</td>
              <td>
                <span className={`qq-motion-kind is-${row.kind}`}>{row.kind}</span>
              </td>
              <td className="qq-motion-td-time">
                {fmtMs(row.startMs)} → {fmtMs(row.endMs)}
              </td>
              <td className="qq-motion-td-core" title={core}>
                {core}
              </td>
              <td className="qq-motion-td-steps">
                {row.stepTimes?.length
                  ? row.stepTimes.map((ms, i) => <span key={i}>{fmtMs(ms)}</span>)
                  : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
