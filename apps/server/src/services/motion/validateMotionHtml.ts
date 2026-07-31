import type { MotionTimeline } from '@bokebox/shared/motion';

export interface MotionHtmlValidation {
  ok: boolean;
  errors: string[];
  beatsFound: number;
  timelineBeats: number;
  runtimeMarkers: string[];
}

const RUNTIME_MARKERS = [
  'requestAnimationFrame',
  'performance.now()',
  'data-start-ms',
  'data-step-times',
  'autoplay-running',
  'animating',
  'settled',
];

/**
 * S5 静态校验：字符串级检查装配产物与已确认时间轴一致。
 *
 * - beat 数量与时间轴一致（<section class="beat …data-kind=…">）
 * - 每个 beat 的 data-start-ms / data-end-ms 为合法毫秒
 * - step 绝对毫秒点严格递增且落在 (startMs, endMs)
 * - 收束页 endMs 贴合 durationMs（±300ms）
 * - 运行时必需标记齐全（主时钟 rAF、门控 class）
 * - id 唯一
 */
export function validateMotionHtml(html: string, timeline: MotionTimeline): MotionHtmlValidation {
  const errors: string[] = [];
  const beatSections = html.match(/<section class="beat[^"]*" id="[^"]+" data-kind="[^"]+" data-steps="\d+" data-start-ms="\d+" data-end-ms="\d+" data-step-times="[^"]*">/g) || [];
  const beatsFound = beatSections.length;
  const timelineBeats = timeline.beats.length;

  if (beatsFound !== timelineBeats) {
    errors.push(`beat 数量不一致：HTML ${beatsFound} vs 时间轴 ${timelineBeats}`);
  }

  const ids = new Set<string>();
  for (const section of beatSections) {
    const idMatch = / id="([^"]+)"/.exec(section);
    const kindMatch = / data-kind="([^"]+)"/.exec(section);
    const startMatch = / data-start-ms="(\d+)"/.exec(section);
    const endMatch = / data-end-ms="(\d+)"/.exec(section);
    const stepTimesMatch = / data-step-times="([^"]*)"/.exec(section);
    if (!idMatch || !kindMatch || !startMatch || !endMatch || !stepTimesMatch) continue;

    const id = idMatch[1];
    if (ids.has(id)) errors.push(`id 重复：${id}`);
    ids.add(id);

    const startMs = Number(startMatch[1]);
    const endMs = Number(endMatch[1]);
    const stepTimes = stepTimesMatch[1]
      .split(',')
      .filter(Boolean)
      .map((v) => Number(v));

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      errors.push(`${id}: 非法毫秒窗口 ${startMs}–${endMs}`);
      continue;
    }
    if (kindMatch[1] === 'closing' && Math.abs(endMs - timeline.durationMs) > 300) {
      errors.push(`${id}: 收束页 endMs=${endMs} 未贴合 durationMs=${timeline.durationMs}`);
    }
    let prev = startMs;
    for (const t of stepTimes) {
      if (t <= prev || t >= endMs) {
        errors.push(`${id}: 步骤毫秒点越界/未递增（${t}，窗口 ${startMs}–${endMs}）`);
        break;
      }
      prev = t;
    }
  }

  const runtimeMarkers = RUNTIME_MARKERS.filter((m) => html.includes(m));
  if (runtimeMarkers.length !== RUNTIME_MARKERS.length) {
    const missing = RUNTIME_MARKERS.filter((m) => !html.includes(m));
    errors.push(`运行时标记缺失：${missing.join(', ')}`);
  }

  // 时间轴顺序校验：HTML 中的 beat 应按 startMs 升序出现
  const starts = beatSections
    .map((s) => / data-start-ms="(\d+)"/.exec(s)?.[1])
    .filter(Boolean)
    .map(Number);
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] < starts[i - 1]) {
      errors.push(`beat 顺序错乱：startMs ${starts[i - 1]} → ${starts[i]}`);
      break;
    }
  }

  return { ok: errors.length === 0, errors, beatsFound, timelineBeats, runtimeMarkers };
}
