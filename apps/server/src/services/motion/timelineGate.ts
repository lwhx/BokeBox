/**
 * Motion 模式 · S3.5 P3.5 时间轴确认门
 *
 * 分镜产物必须通过 P3.5 门禁才能被确认并进入装配：
 * - 全覆盖：首 beat 从 0ms 开始，收束页 endMs 贴合主时钟总时长；
 * - 相邻 beat 不重叠、空档 ≤ 500ms；
 * - step 毫秒点严格递增且落在 beat 区间内。
 * 确认后的时间轴写入 motion-timeline.json，装配阶段只消费已确认时间轴。
 */
import fs from 'node:fs/promises';
import {
  buildCoverageRows,
  validateTimeline,
  type GateResult,
  type MotionBeat,
  type MotionTimeline,
} from '@bokebox/shared';
import { jobPaths } from '../../utils/paths.js';
import { pathExists } from '../../utils/fs.js';

export type { GateResult, MotionBeat, MotionTimeline };

export interface GateOutput {
  gate: GateResult;
  timeline: MotionTimeline | null;
}

/** 构建 P3.5 门禁输出（不落盘）。 */
export function runTimelineGate(input: {
  jobId: string;
  title: string;
  beats: MotionBeat[];
  durationMs: number;
  srtCueCount: number;
  optimizedCueCount: number;
}): GateOutput {
  const gate = validateTimeline(input.beats, input.durationMs);
  const timeline: MotionTimeline | null = gate.pass
    ? {
        version: 1,
        jobId: input.jobId,
        title: input.title,
        durationMs: input.durationMs,
        source: 'srt',
        srtCueCount: input.srtCueCount,
        optimizedCueCount: input.optimizedCueCount,
        beats: input.beats.map((b) => ({ ...b, stepTimes: [...b.stepTimes] })),
      }
    : null;
  return { gate, timeline };
}

/** 确认时间轴：门禁未通过返回 null 并给出违规；通过则落盘。 */
export async function confirmTimeline(
  jobId: string,
  timeline: MotionTimeline,
): Promise<{ ok: true; file: string } | { ok: false; gate: GateResult }> {
  const gate = validateTimeline(timeline.beats, timeline.durationMs);
  if (!gate.pass) return { ok: false, gate };
  const file = jobPaths(jobId).motionTimeline;
  await fs.writeFile(
    file,
    JSON.stringify({ ...timeline, createdAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  return { ok: true, file };
}

/** 读取已确认时间轴。 */
export async function readConfirmedTimeline(
  jobId: string,
): Promise<MotionTimeline | null> {
  const file = jobPaths(jobId).motionTimeline;
  if (!(await pathExists(file))) return null;
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as MotionTimeline;
    if (raw?.version !== 1 || !Array.isArray(raw.beats)) return null;
    const gate = validateTimeline(raw.beats, raw.durationMs);
    return gate.pass ? raw : null;
  } catch {
    return null;
  }
}

export { buildCoverageRows };
