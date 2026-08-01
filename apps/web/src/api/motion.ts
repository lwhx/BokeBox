import type {
  CoverageRow,
  GateResult,
  MotionBeat,
  MotionTimeline,
} from '@bokebox/shared/motion';
import { request } from './http';

export interface MotionSrtInfo {
  source: 'podcast.srt' | 'script-timing';
  rawCues: number;
  optimizedCues: number;
  durationMs: number;
  optimizedSrtText: string;
}

export interface MotionDraftResponse {
  ok: boolean;
  title: string;
  gate: GateResult | null;
  rows: CoverageRow[];
  beats: MotionBeat[];
  durationMs: number;
  notes: string[];
  srtInfo: MotionSrtInfo | null;
  message?: string;
}

export interface MotionBuildResponse {
  ok: boolean;
  timeline: MotionTimeline | null;
  gate: GateResult | null;
  html?: { file: string; bytes: number; title: string };
  error?: string;
  message?: string;
}

export interface MotionGenerateResponse extends MotionBuildResponse {
  timeline: MotionTimeline | null;
}

export interface MotionTimelineResponse {
  ok: boolean;
  hasTimeline: boolean;
  timeline: MotionTimeline | null;
  durationMs: number;
  beats: MotionBeat[];
}

export function motionTimelineUrl(jobId: string, download = false): string {
  const base = `/jobs/${encodeURIComponent(jobId)}/motion.html`;
  return download ? `${base}?download=1` : base;
}

export function motionSrtUrl(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/motion.srt?download=1`;
}

/** 已确认时间轴（含覆盖表与门禁状态） */
export function fetchMotionTimeline(jobId: string): Promise<MotionTimelineResponse> {
  return request<MotionTimelineResponse>(`/jobs/${encodeURIComponent(jobId)}/motion/timeline`);
}

/** P3.5 预检：优化 SRT + 分镜 + 门禁（不落盘，返回覆盖表与违规） */
export function draftMotionTimeline(jobId: string): Promise<MotionDraftResponse> {
  return request<MotionDraftResponse>(`/jobs/${encodeURIComponent(jobId)}/motion/draft`, {
    method: 'POST',
  });
}

/** 根据口播稿调用 AI 生成页面并保存，时间轴仍由 SRT 主时钟固定。 */
export function generateMotionPage(
  jobId: string,
  prompt?: string,
): Promise<MotionGenerateResponse> {
  return request<MotionGenerateResponse>(`/jobs/${encodeURIComponent(jobId)}/motion/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt?.trim() || undefined }),
  });
}

/** P3.5 确认门：门禁通过才落盘并装配 HTML */
export function confirmMotionTimeline(
  jobId: string,
  beats: MotionBeat[],
): Promise<MotionBuildResponse> {
  return request<MotionBuildResponse>(`/jobs/${encodeURIComponent(jobId)}/motion/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ beats }),
  });
}

/** 用已确认时间轴重新装配 HTML（时间轴未变时重复导出） */
export function rebuildMotionHtml(jobId: string): Promise<MotionBuildResponse> {
  return request<MotionBuildResponse>(`/jobs/${encodeURIComponent(jobId)}/motion/build`, {
    method: 'POST',
  });
}
