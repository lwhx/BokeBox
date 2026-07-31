/**
 * Motion 模式共享类型与纯逻辑
 *
 * 参考 jacky-motion（MIT，https://github.com/jackywxsz/jacky-motion）的
 * 「SRT 唯一主时钟」思想：SRT 只提供时间与文本索引，最终画面由
 * 主时钟（performance.now + requestAnimationFrame）推进，分镜 / 步骤 /
 * 收束页全部绑定真实毫秒点（data-start-ms / data-end-ms / data-step-times）。
 *
 * 本模块只包含无 IO 的纯函数与类型，供服务端时间轴门禁、SRT 优化
 * 与前端展示共用，避免多套规则漂移。
 */

/* ═══════════════════════ SRT 解析与优化 ═══════════════════════ */

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

/** 毫秒 → SRT 时间码 HH:MM:SS,mmm */
export function formatSrtTimestampMs(ms: number): string {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const totalMs = safe;
  const m = Math.floor(totalMs / 1000);
  const h = Math.floor(m / 3600);
  const mm = Math.floor((m % 3600) / 60);
  const s = m % 60;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(h)}:${pad2(mm)}:${pad2(s)},${pad3(totalMs % 1000)}`;
}

/** 毫秒 → 展示用时钟 mm:ss.mmm */
export function formatMotionClock(ms: number): string {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const total = Math.floor(safe / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  const mmm = String(safe % 1000).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

const SRT_TIME_RE =
  /(\d{1,2}):(\d{1,2}):(\d{1,2})[,.:](\d{1,3})\s*-->\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[,.:](\d{1,3})/;

function toMs(h: string, m: string, s: string, ms: string): number {
  return (
    Number(h) * 3600_000 +
    Number(m) * 60_000 +
    Number(s) * 1000 +
    Number(ms.padEnd(3, '0').slice(0, 3))
  );
}

function normalizeCueText(text: string): string {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * 解析 SRT 文本 → 毫秒级 cue 列表。
 * 容忍时间倒退 / 重叠 / 空文本：这里只做解析，问题由 optimizeSrt 修复或上报。
 */
export function parseSrt(text: string): SrtCue[] {
  const source = String(text || '');
  if (!source.trim()) return [];

  const rawBlocks = source
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const cues: SrtCue[] = [];
  for (const block of rawBlocks) {
    const lines = block.split('\n');
    const timeLineIndex = lines.findIndex((line) => SRT_TIME_RE.test(line));
    if (timeLineIndex < 0) continue;
    const m = lines[timeLineIndex].match(SRT_TIME_RE);
    if (!m) continue;
    const startMs = toMs(m[1], m[2], m[3], m[4]);
    const endMs = toMs(m[5], m[6], m[7], m[8]);
    const text = normalizeCueText(lines.slice(timeLineIndex + 1).join(' '));
    cues.push({
      index: cues.length + 1,
      startMs,
      endMs,
      text,
    });
  }
  return cues;
}

/** 由 cue 列表序列化 SRT（毫秒精确，空文本 cue 跳过） */
export function buildSrtFromCues(cues: SrtCue[]): string {
  const rows = (cues || [])
    .filter((cue) => cue && cue.endMs > cue.startMs && cue.text.trim())
    .map((cue, index) => {
      const text = normalizeCueText(cue.text);
      return [
        String(index + 1),
        `${formatSrtTimestampMs(cue.startMs)} --> ${formatSrtTimestampMs(cue.endMs)}`,
        text,
      ].join('\n');
    });
  return rows.length ? `${rows.join('\n\n')}\n` : '';
}

export interface SrtOptimizeOptions {
  /** 短于该毫秒的 cue 尝试并入前一句（默认 600） */
  minCueMs?: number;
  /** 相邻 cue 间隔小于该毫秒且文本可续接时合并（默认 300） */
  mergeGapMs?: number;
  /** 超过该毫秒的长 cue 在句读处切分（默认 12_000） */
  splitLongMs?: number;
  /** 空白文本 cue 直接丢弃 */
  dropEmpty?: boolean;
}

export interface SrtOptimizeStats {
  inputCues: number;
  outputCues: number;
  merged: number;
  split: number;
  dropped: number;
  repairedOverlap: number;
  /** 首条 cue start 到末条 cue end 的总毫秒 */
  coverageMs: number;
  /** 相邻 cue 之间累计空档毫秒（>0 表示存在静音） */
  gapMs: number;
  /** 超过 500ms 的空档个数（主时钟会当作口播停顿保留） */
  bigGapCount: number;
}

export interface OptimizedSrt {
  cues: SrtCue[];
  stats: SrtOptimizeStats;
  notes: string[];
}

/** 句末标点：这些位置允许作为切分 / 合并边界 */
const SENTENCE_END_RE = /[。！？!?；;…]$/u;
const LONG_PUNCT_RE = /(?<=[。！？!?；;…])\s*/gu;

function charWeight(text: string): number {
  return Math.max(1, Array.from(text.replace(/\s+/gu, '')).length);
}

/**
 * 优化 SRT（毫秒级主时钟原料）：
 * 1. 排序 + 重叠修复（end 钳到下一句 start） + 丢弃空 cue；
 * 2. 短句/小空档合并：避免碎 cue 打断主时钟；
 * 3. 超长 cue 在句读处按字重切分：避免画面长时间不动；
 * 4. 统计覆盖率与空档，供 P3.5 覆盖表使用。
 */
export function optimizeSrt(
  input: SrtCue[],
  opts?: SrtOptimizeOptions,
): OptimizedSrt {
  const minCueMs = opts?.minCueMs ?? 600;
  const mergeGapMs = opts?.mergeGapMs ?? 300;
  const splitLongMs = opts?.splitLongMs ?? 12_000;
  const dropEmpty = opts?.dropEmpty ?? true;
  const notes: string[] = [];

  const stats: SrtOptimizeStats = {
    inputCues: input.length,
    outputCues: 0,
    merged: 0,
    split: 0,
    dropped: 0,
    repairedOverlap: 0,
    coverageMs: 0,
    gapMs: 0,
    bigGapCount: 0,
  };

  let cues = (input || [])
    .filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  if (dropEmpty) {
    const before = cues.length;
    cues = cues.filter((cue) => cue.text.trim().length > 0);
    stats.dropped += before - cues.length;
  }
  if (!cues.length) {
    stats.outputCues = 0;
    return { cues: [], stats, notes: notes.concat('SRT 无可用的字幕 cue') };
  }

  // 1) 重叠修复 + 最小时长
  for (let i = 0; i < cues.length - 1; i += 1) {
    const cur = cues[i];
    const next = cues[i + 1];
    if (cur.endMs > next.startMs) {
      cur.endMs = Math.max(cur.startMs + 1, next.startMs);
      stats.repairedOverlap += 1;
    }
    if (cur.endMs <= cur.startMs) {
      cur.endMs = cur.startMs + 150;
    }
  }
  const last = cues[cues.length - 1];
  if (last.endMs <= last.startMs) last.endMs = last.startMs + 150;

  // 2) 短句 / 小空档合并
  const merged: SrtCue[] = [];
  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...cue });
      continue;
    }
    const gap = cue.startMs - prev.endMs;
    const prevEndsSentence = SENTENCE_END_RE.test(prev.text.trim());
    const isFragment =
      cue.endMs - cue.startMs < minCueMs ||
      (gap >= 0 && gap < mergeGapMs && !prevEndsSentence);
    if (isFragment && cue.text.trim()) {
      prev.endMs = cue.endMs;
      prev.text = `${prev.text} ${cue.text}`.trim();
      stats.merged += 1;
      continue;
    }
    merged.push({ ...cue });
  }

  // 3) 超长 cue 在句读处切分
  const splitOut: SrtCue[] = [];
  for (const cue of merged) {
    const duration = cue.endMs - cue.startMs;
    if (duration <= splitLongMs || !LONG_PUNCT_RE.test(cue.text)) {
      splitOut.push(cue);
      continue;
    }
    const parts = cue.text
      .split(LONG_PUNCT_RE)
      .map((p) => p.trim())
      .filter(Boolean);
    // 句读位置太少（整句无标点）则整条保留
    if (parts.length < 2) {
      splitOut.push(cue);
      continue;
    }
    const totalWeight = parts.reduce((a, p) => a + charWeight(p), 0) || 1;
    let acc = 0;
    let pieceStart = cue.startMs;
    const pieces: SrtCue[] = [];
    for (const part of parts) {
      acc += charWeight(part);
      const pieceEnd =
        part === parts[parts.length - 1]
          ? cue.endMs
          : cue.startMs + Math.round((acc / totalWeight) * duration);
      if (pieceEnd > pieceStart) {
        pieces.push({
          index: 0,
          startMs: pieceStart,
          endMs: pieceEnd,
          text: part,
        });
        pieceStart = pieceEnd;
      }
    }
    if (pieces.length >= 2) {
      splitOut.push(...pieces);
      stats.split += 1;
    } else {
      splitOut.push(cue);
    }
  }

  // 4) 重新编号 + 空档统计
  const output = splitOut.map((cue, index) => ({ ...cue, index: index + 1 }));
  stats.outputCues = output.length;
  stats.coverageMs = output.length
    ? output[output.length - 1].endMs - output[0].startMs
    : 0;
  let gapMs = 0;
  let bigGapCount = 0;
  for (let i = 0; i < output.length - 1; i += 1) {
    const gap = output[i + 1].startMs - output[i].endMs;
    if (gap > 0) {
      gapMs += gap;
      if (gap > 500) {
        bigGapCount += 1;
        notes.push(
          `cue ${output[i].index}→${output[i + 1].index} 存在 ${gap}ms 停顿（主时钟保留该静音）`,
        );
      }
    }
  }
  stats.gapMs = gapMs;
  stats.bigGapCount = bigGapCount;
  if (stats.merged > 0) notes.push(`合并 ${stats.merged} 条碎 cue`);
  if (stats.split > 0) notes.push(`切分 ${stats.split} 条超长 cue`);
  if (stats.repairedOverlap > 0) notes.push(`修复 ${stats.repairedOverlap} 处时间重叠`);
  return { cues: output, stats, notes };
}

/* ═══════════════════════ Motion 分镜 / 时间轴 ═══════════════════════ */

export type MotionBeatKind = 'motion' | 'broll' | 'closing';

export interface MotionBeat {
  /** 稳定 id，如 b1 / b2…，收束页为 bn+1 */
  id: string;
  kind: MotionBeatKind;
  /** 屏幕文字（核心信息，短于口播，视觉索引） */
  title: string;
  /** 口播描述（不进屏幕，供人工核对） */
  detail?: string;
  /** 真实毫秒起点 */
  startMs: number;
  /** 真实毫秒终点（收束页 = 末条 cue 的 endMs） */
  endMs: number;
  /** step 2..N 的绝对毫秒点，严格递增且落在 (startMs, endMs)；broll 通常为空 */
  stepTimes: number[];
  /** step 1..N 的屏幕文字（可选） */
  stepLabels?: string[];
  /** 覆盖的 cue 范围（1-based，来自优化后 SRT）；broll 无 cue 覆盖时为 [0,0] */
  cueRange: [number, number];
  /** B-roll 大空档的静音区间起止（仅 kind='broll' 时有效） */
  brollSilence?: { gapStartMs: number; gapEndMs: number };
}

export type MotionSceneLayout = 'hero' | 'split' | 'steps' | 'quote' | 'closing';

/** AI 根据口播稿生成的视觉页面内容；时间仍由 MotionBeat/SRT 唯一决定。 */
export interface MotionScene {
  beatId: string;
  layout: MotionSceneLayout;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  accent: string;
}

export interface MotionPageSpec {
  version: 1;
  source: 'ai' | 'fallback';
  prompt?: string;
  generatedAt: string;
  scenes: MotionScene[];
}

export interface MotionTimeline {
  version: 1;
  jobId: string;
  title: string;
  durationMs: number;
  source: 'srt';
  srtCueCount: number;
  optimizedCueCount: number;
  beats: MotionBeat[];
  /** 可选视觉页面层，旧时间轴仍可正常读取。 */
  page?: MotionPageSpec;
  createdAt?: string;
}

export interface CoverageRow {
  beatId: string;
  kind: MotionBeatKind;
  startMs: number;
  endMs: number;
  core: string;
  stepTimes: number[];
  cueRange: [number, number];
}

export type GateViolationCode =
  | 'first-beat-not-zero'
  | 'beat-overlap'
  | 'beat-gap'
  | 'step-out-of-range'
  | 'step-not-monotonic'
  | 'step-count-mismatch'
  | 'closing-not-at-end'
  | 'empty-beat'
  | 'unsorted';

export interface GateViolation {
  code: GateViolationCode;
  beatId?: string;
  atMs?: number;
  message: string;
}

export interface GateResult {
  pass: boolean;
  rows: CoverageRow[];
  violations: GateViolation[];
  durationMs: number;
  /** 首条 cue start → 末条 cue end 的覆盖率（ms） */
  coverageMs: number;
  /** 相邻 beat 空档累计（ms） */
  gapMs: number;
}

/**
 * 门禁空档门限。skill 原文为 500ms（人工分镜的严格标准）；BokeBox 为自动化
 * 分镜，TTS 句间停顿可达 ~1.5s（属于正常口播节奏，画面停留可接受），因此
 * 放宽到 1500ms，且 ≥1500ms 的停顿由 storyboard 强制切分并填充 broll。
 */
export const GATE_GAP_LIMIT_MS = 1500;
export const GATE_END_TOLERANCE_MS = 300;

/** 由 beats 生成 P3.5 覆盖表 */
export function buildCoverageRows(beats: MotionBeat[]): CoverageRow[] {
  return (beats || []).map((beat) => ({
    beatId: beat.id,
    kind: beat.kind,
    startMs: beat.startMs,
    endMs: beat.endMs,
    core: beat.title,
    stepTimes: [...(beat.stepTimes || [])],
    cueRange: beat.cueRange ? [beat.cueRange[0], beat.cueRange[1]] : [0, 0],
  }));
}

/**
 * P3.5 时间轴确认门（纯校验，可单测）：
 * - 首 beat 从 0ms 开始；
 * - 相邻 beat 不重叠，空档 ≤ 1500ms（≥1500ms 的大空档应由 broll beat 填充，
 *   broll 也是正式 beat，参与同样的 gap 检查，因此被覆盖的空档不会触发违规）；
 * - steps 绝对毫秒点严格递增且落在 beat 区间内；
 * - 收束页（closing）的 endMs 必须贴合主时钟总时长；
 * - beats 必须按时间排序。
 */
export function validateTimeline(
  beats: MotionBeat[],
  durationMs: number,
  opts?: { gapLimitMs?: number; endToleranceMs?: number },
): GateResult {
  const gapLimitMs = opts?.gapLimitMs ?? GATE_GAP_LIMIT_MS;
  const endToleranceMs = opts?.endToleranceMs ?? GATE_END_TOLERANCE_MS;
  const violations: GateViolation[] = [];
  const sorted = [...(beats || [])].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );

  if (!sorted.length) {
    violations.push({
      code: 'empty-beat',
      message: '时间轴为空：没有可分镜的 beat',
    });
    return { pass: false, rows: [], violations, durationMs, coverageMs: 0, gapMs: 0 };
  }

  // 原序是否已排序（生成侧必须有序，前端展示依赖）
  const wasSorted = beats.every(
    (b, i) => i === 0 || beats[i - 1].startMs <= b.startMs,
  );
  if (!wasSorted) {
    violations.push({
      code: 'unsorted',
      message: 'beat 未按 startMs 排序',
    });
  }

  for (const beat of sorted) {
    if (!Number.isFinite(beat.startMs) || !Number.isFinite(beat.endMs)) {
      violations.push({ code: 'empty-beat', beatId: beat.id, message: `${beat.id} 时间非法` });
      continue;
    }
    if (beat.endMs <= beat.startMs) {
      violations.push({
        code: 'empty-beat',
        beatId: beat.id,
        atMs: beat.startMs,
        message: `${beat.id} 区间为空（${beat.startMs}→${beat.endMs}ms）`,
      });
    }
    const steps = beat.stepTimes || [];
    for (let i = 0; i < steps.length; i += 1) {
      const t = steps[i];
      if (!Number.isFinite(t) || t <= beat.startMs || t >= beat.endMs) {
        violations.push({
          code: 'step-out-of-range',
          beatId: beat.id,
          atMs: t,
          message: `${beat.id} step${i + 2} 毫秒点 ${t} 超出区间 [${beat.startMs}, ${beat.endMs})`,
        });
      }
      if (i > 0 && t <= steps[i - 1]) {
        violations.push({
          code: 'step-not-monotonic',
          beatId: beat.id,
          atMs: t,
          message: `${beat.id} step 毫秒点未严格递增`,
        });
      }
    }
  }

  let prevEnd = 0;
  let gapMs = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const beat = sorted[i];
    if (i === 0) {
      if (Math.abs(beat.startMs - 0) > 50) {
        violations.push({
          code: 'first-beat-not-zero',
          beatId: beat.id,
          atMs: beat.startMs,
          message: `首 beat 必须从 0ms 开始，实际 ${beat.startMs}ms`,
        });
      }
    } else {
      if (beat.startMs < prevEnd) {
        violations.push({
          code: 'beat-overlap',
          beatId: beat.id,
          atMs: beat.startMs,
          message: `${beat.id} 与上一 beat 重叠（${prevEnd} > ${beat.startMs}）`,
        });
      } else {
        const gap = beat.startMs - prevEnd;
        if (gap > gapLimitMs) {
          violations.push({
            code: 'beat-gap',
            beatId: beat.id,
            atMs: beat.startMs,
            message: `${beat.id} 前存在 ${gap}ms 空档（超过 ${gapLimitMs}ms 门限）`,
          });
        }
        gapMs += Math.max(0, gap);
      }
    }
    prevEnd = Math.max(prevEnd, beat.endMs);
  }

  const lastBeat = sorted[sorted.length - 1];
  if (Math.abs(lastBeat.endMs - durationMs) > endToleranceMs) {
    violations.push({
      code: 'closing-not-at-end',
      beatId: lastBeat.id,
      atMs: lastBeat.endMs,
      message: `收束页 endMs 必须贴合主时钟总时长（${durationMs}ms），实际 ${lastBeat.endMs}ms`,
    });
  }

  return {
    pass: violations.length === 0,
    rows: buildCoverageRows(sorted),
    violations,
    durationMs,
    coverageMs: sorted.length
      ? lastBeat.endMs - sorted[0].startMs
      : 0,
    gapMs,
  };
}

/** 把 ScriptLineTiming 秒级行转成毫秒级 SRT cue（无 SRT 文件时的兜底） */
export function cuesFromTiming(
  lines: Array<{ text: string; startSec: number; endSec: number }>,
): SrtCue[] {
  return (lines || [])
    .filter(
      (line) =>
        line &&
        Number.isFinite(line.startSec) &&
        Number.isFinite(line.endSec) &&
        line.endSec > line.startSec &&
        String(line.text || '').trim(),
    )
    .map((line, index) => ({
      index: index + 1,
      startMs: Math.round(line.startSec * 1000),
      endMs: Math.round(line.endSec * 1000),
      text: String(line.text || '').trim(),
    }));
}

/** 提取 cue 文本的前缀作为屏幕文字候选 */
export function shortScreenText(text: string, max = 26): string {
  const clean = String(text || '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!clean) return '';
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max - 1).join('')}…`;
}
