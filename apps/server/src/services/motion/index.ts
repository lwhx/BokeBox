/**
 * Motion 模式 · 编排（S1 优化 SRT → S3 分镜 → S3.5 确认门 → S4 装配）
 *
 * 对外暴露三个操作：
 * - draftTimeline：读 SRT → 优化 → 分镜 → P3.5 门禁预检，返回覆盖表与违规（不落盘）
 * - confirmAndBuild：确认时间轴（门禁通过才落盘）→ 生成单文件 HTML
 * - buildFromConfirmed：直接用已确认时间轴重新装配 HTML（时间轴未变时）
 */
import type { Job } from '@bokebox/shared';
import {
  buildCoverageRows,
  validateTimeline,
  type CoverageRow,
  type GateResult,
  type MotionBeat,
  type MotionPageSpec,
  type MotionStyleOptions,
  type MotionTimeline,
} from '@bokebox/shared';
import { loadOptimizedSrt } from './srtOptimizer.js';
import { buildStoryboard } from './storyboard.js';
import {
  readConfirmedTimeline,
  runTimelineGate,
} from './timelineGate.js';
import { buildMotionHtmlFile, renderMotionHtml } from './motionHtml.js';
import { validateMotionHtml } from './validateMotionHtml.js';
import { readScriptTiming } from '../job/scriptTiming.js';
import { generateMotionPage } from './pageGenerator.js';
import fs from 'node:fs/promises';
import { jobPaths } from '../../utils/paths.js';

export interface MotionDraft {
  ok: boolean;
  title: string;
  gate: GateResult | null;
  rows: CoverageRow[];
  durationMs: number;
  beats: MotionBeat[];
  notes: string[];
  srtInfo: {
    source: 'podcast.srt' | 'script-timing';
    rawCues: number;
    optimizedCues: number;
    durationMs: number;
    optimizedSrtText: string;
  } | null;
  error?: string;
}

/** 获取某 job 的口播逐行时间轴（用于 cue ↔ 行对齐） */
function timingFallback(job: Job) {
  const paths = jobPaths(job.id);
  return {
    lines: job.podcast?.scriptTiming,
    script: job.podcast?.script,
    audioPaths: [job.podcastAudioPath, paths.podcastMp3, paths.podcastWav].filter(
      (value): value is string => Boolean(value),
    ),
  };
}

async function loadLines(
  job: Job,
): Promise<Array<{ text: string; startSec: number; endSec: number }>> {
  const timing = await readScriptTiming(job.id, job.podcast?.script);
  return timing?.lines ?? job.podcast?.scriptTiming ?? [];
}

/**
 * 生成分镜草稿并跑 P3.5 门禁预检。
 * 正常情况下不改动时间轴；老任务缺少文件时，会先恢复可用的口播时间轴。
 */
export async function draftTimeline(job: Job): Promise<MotionDraft> {
  const srt = await loadOptimizedSrt(job.id, timingFallback(job));
  if (!srt) {
    return {
      ok: false,
      title: job.podcast?.title || job.title,
      gate: null,
      rows: [],
      durationMs: 0,
      beats: [],
      notes: ['没有可用的口播时间轴：请先完成音频合成，或重新生成口播时间轴。'],
      srtInfo: null,
      error: 'missing-srt',
    };
  }

  const lines = await loadLines(job);
  const outline = job.podcast?.outline?.length ? job.podcast.outline : undefined;
  const story = buildStoryboard({
    title: job.podcast?.title || job.title,
    cues: srt.cues,
    lines,
    outline,
    chapters: job.podcast?.motionChapters,
  });

  const { gate, timeline } = runTimelineGate({
    jobId: job.id,
    title: job.podcast?.title || job.title,
    beats: story.beats,
    durationMs: srt.durationMs,
    srtCueCount: srt.rawCues,
    optimizedCueCount: srt.cues.length,
  });

  return {
    ok: gate.pass,
    title: job.podcast?.title || job.title,
    gate,
    rows: gate.rows,
    durationMs: srt.durationMs,
    beats: story.beats,
    notes: srt.notes.concat(story.notes),
    srtInfo: {
      source: srt.source,
      rawCues: srt.rawCues,
      optimizedCues: srt.cues.length,
      durationMs: srt.durationMs,
      optimizedSrtText: srt.optimizedSrtText,
    },
    error: gate.pass ? undefined : 'gate-failed',
  };
}

export interface MotionBuildResult {
  ok: boolean;
  timeline: MotionTimeline | null;
  gate: GateResult | null;
  html?: { file: string; bytes: number; title: string };
  error?: string;
}

/**
 * 确认时间轴并装配 HTML。
 * 只有通过 P3.5 确认门（全覆盖 + 无重叠 + 空档 ≤500ms + step 毫秒点合法 +
 * 收束页贴合主时钟）的时间轴才会落盘并进入装配。
 */
export async function confirmAndBuild(
  job: Job,
  beats: MotionBeat[],
  page?: MotionPageSpec,
): Promise<MotionBuildResult> {
  const srt = await loadOptimizedSrt(job.id, timingFallback(job));
  if (!srt) {
    return { ok: false, timeline: null, gate: null, error: 'missing-srt' };
  }
  const gate = validateTimeline(beats, srt.durationMs);
  if (!gate.pass) {
    return { ok: false, timeline: null, gate, error: 'gate-failed' };
  }
  const timeline: MotionTimeline = {
    version: 1,
    jobId: job.id,
    title: job.podcast?.title || job.title,
    durationMs: srt.durationMs,
    source: 'srt',
    srtCueCount: srt.rawCues,
    optimizedCueCount: srt.cues.length,
    beats: beats.map((b) => ({ ...b, stepTimes: [...b.stepTimes] })),
    page,
  };
  const built = await buildMotionHtmlFile(job.id, timeline);
  if (!built.ok) {
    return { ok: false, timeline, gate, error: built.error };
  }
  return {
    ok: true,
    timeline,
    gate,
    html: { file: built.file, bytes: built.bytes, title: timeline.title },
  };
}

/** 根据口播稿生成视觉页面，并沿用同一条 SRT 时间轴完成在线预览产物。 */
export async function generateAndBuild(
  job: Job,
  prompt?: string,
  styleOptions?: MotionStyleOptions,
): Promise<MotionBuildResult> {
  const draft = await draftTimeline(job);
  if (!draft.ok || !draft.gate) {
    return {
      ok: false,
      timeline: null,
      gate: draft.gate,
      error: draft.error || 'gate-failed',
    };
  }
  const page = await generateMotionPage(job, draft.beats, prompt, styleOptions);
  return confirmAndBuild(job, draft.beats, page);
}

/** 用已确认时间轴直接重新装配 HTML（适合重复导出，不改时间轴） */
export async function buildFromConfirmed(job: Job): Promise<MotionBuildResult> {
  const timeline = await readConfirmedTimeline(job.id);
  if (!timeline) {
    return { ok: false, timeline: null, gate: null, error: 'no-confirmed-timeline' };
  }
  const gate = validateTimeline(timeline.beats, timeline.durationMs);
  if (!gate.pass) {
    return { ok: false, timeline, gate, error: 'confirmed-timeline-invalid' };
  }
  const html = renderMotionHtml(timeline, job.id);
  const check = validateMotionHtml(html, timeline);
  if (!check.ok) {
    return {
      ok: false,
      timeline,
      gate,
      error: `html-invalid: ${check.errors.join('; ')}`,
    };
  }
  const file = jobPaths(job.id).motionHtml;
  await fs.writeFile(file, html, 'utf8');
  return {
    ok: true,
    timeline,
    gate,
    html: { file, bytes: Buffer.byteLength(html, 'utf8'), title: timeline.title },
  };
}

export { buildCoverageRows, readConfirmedTimeline };
