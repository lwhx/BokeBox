/**
 * Motion 模式 · S1 优化 SRT（主时钟原料）
 *
 * 读取 podcast.srt（TTS 合成时写入）；缺失时用 script-timing.json 兜底，
 * 再做毫秒级优化：碎句合并、超长句切分、重叠修复、覆盖率统计。
 */
import fs from 'node:fs/promises';
import {
  buildSrtFromCues,
  cuesFromTiming,
  optimizeSrt,
  parseSrt,
  type OptimizedSrt,
  type SrtCue,
} from '@bokebox/shared';
import { jobPaths } from '../../utils/paths.js';
import { pathExists } from '../../utils/fs.js';
import { readScriptTiming } from '../job/scriptTiming.js';

export type { OptimizedSrt, SrtCue };

export interface SrtSourceInfo {
  /** 读取来源：podcast.srt 文件 / script-timing 兜底 */
  source: 'podcast.srt' | 'script-timing';
  /** 原始 cue 数（优化前） */
  rawCues: number;
  /** 优化后毫秒级 cue（主时钟原料） */
  cues: SrtCue[];
  /** 优化统计与说明 */
  stats: OptimizedSrt['stats'];
  notes: string[];
  /** 主时钟总时长 = 末条 cue 的 endMs */
  durationMs: number;
  /** 优化后的 SRT 文本（可下载） */
  optimizedSrtText: string;
}

/** 读取并优化某 job 的 SRT；数据不完整时返回 null。 */
export async function loadOptimizedSrt(jobId: string): Promise<SrtSourceInfo | null> {
  const paths = jobPaths(jobId);
  let srtText: string | null = null;
  let source: SrtSourceInfo['source'] = 'podcast.srt';
  let rawTimingLines: Array<{ text: string; startSec: number; endSec: number }> | null = null;

  if (await pathExists(paths.podcastSrt)) {
    srtText = await fs.readFile(paths.podcastSrt, 'utf8');
  }
  if (!srtText?.trim()) {
    const timing = await readScriptTiming(jobId);
    if (timing?.lines?.length) {
      rawTimingLines = timing.lines;
      source = 'script-timing';
    }
  }

  const rawCues = srtText?.trim()
    ? parseSrt(srtText)
    : rawTimingLines
      ? cuesFromTiming(rawTimingLines)
      : [];

  if (!rawCues.length) return null;

  const optimized = optimizeSrt(rawCues);
  if (!optimized.cues.length) return null;

  const last = optimized.cues[optimized.cues.length - 1];
  return {
    source,
    rawCues: rawCues.length,
    cues: optimized.cues,
    stats: optimized.stats,
    notes: optimized.notes,
    durationMs: last.endMs,
    optimizedSrtText: buildSrtFromCues(optimized.cues),
  };
}
