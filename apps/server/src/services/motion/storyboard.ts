/**
 * Motion 模式 · S3 分镜（分镜、步骤、收束页 → 真实毫秒点）
 *
 * 输入：优化后的 SRT cue（主时钟原料）+ 口播脚本逐行时间轴 + 播客大纲。
 * 输出：MotionBeat[]，每个 beat 的 startMs/endMs/stepTimes 全部钉在
 * 真实 cue 的毫秒点上（step 优先钉在语义触发词所在 cue 的 startMs），
 * 最后一个 outline 段作为收束页（closing），endMs 贴合主时钟总时长。
 */
import type {
  MotionBeat,
  MotionBeatKind,
  PodcastSegment,
  ScriptLineTiming,
  SrtCue,
} from '@bokebox/shared';

/* ---- 文本匹配工具（中文 2-gram 命中计分） ---- */

const STOP_WORDS = new Set([
  '的', '了', '与', '和', '在', '是', '为', '而', '及', '或',
  '一个', '这个', '那个', '我们', '你们', '他们', '关于', '如何',
  '：', '，', '。', '？', '！', '、', '…', '—', '·', ' ', '　',
]);

function shingles(text: string, n = 2): string[] {
  const chars = Array.from(String(text || ''));
  const out: string[] = [];
  for (let i = 0; i + n <= chars.length; i += 1) {
    const sh = chars.slice(i, i + n).join('').trim();
    if (sh.length === n && !STOP_WORDS.has(sh)) out.push(sh);
  }
  return out;
}

function overlapScore(needle: string, haystack: string): number {
  const ngrams = shingles(needle);
  if (!ngrams.length) return 0;
  const hay = shingles(haystack);
  let hits = 0;
  for (const ng of ngrams) if (hay.includes(ng)) hits += 1;
  return hits / ngrams.length;
}

function normalizeLine(text: string): string {
  return String(text || '')
    .replace(/[\s，。！？!?；;：、（）()「」『』【】…—–]/gu, '')
    .trim();
}

/* ---- cue ↔ 时间轴行对齐 ---- */

/**
 * 将 SRT cue 与逐行时间轴对齐：
 * - 数量一致 → 按下标一一对应；
 * - 数量不一致 → 按规范化文本最长匹配对齐（文本可含口播标签剥离后的差异）。
 */
export function alignCuesToLines(
  cues: SrtCue[],
  lines: ScriptLineTiming[],
): Array<{ cue: SrtCue; line?: ScriptLineTiming }> {
  if (!cues.length) return [];
  if (!lines.length) return cues.map((cue) => ({ cue }));

  if (cues.length === lines.length) {
    return cues.map((cue, i) => ({ cue, line: lines[i] }));
  }

  const normalizedLines = lines.map((l) => normalizeLine(l.text));
  const paired: Array<{ cue: SrtCue; line?: ScriptLineTiming }> = [];
  let lastMatch = -1;
  for (const cue of cues) {
    const cueNorm = normalizeLine(cue.text);
    if (!cueNorm) {
      paired.push({ cue });
      continue;
    }
    let best = -1;
    let bestScore = 0;
    for (let i = Math.max(0, lastMatch); i < normalizedLines.length; i += 1) {
      const score = overlapScore(cueNorm, normalizedLines[i]);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
      if (score >= 0.9) break;
    }
    if (bestScore >= 0.4) {
      paired.push({ cue, line: lines[best] });
      lastMatch = best;
    } else {
      paired.push({ cue });
    }
  }
  return paired;
}

/* ---- 语义触发词（step 锚点） ---- */

const STEP_TRIGGER_RE =
  /(首先|其次|接下来|然后|接着|再接下来|最后|第一|第二|第三|第四|另一方面|一方面|总结|总而言之|所以|因此|总之|重点|关键是|关键在于|例如|比如|举个例子|也就是说|换句话说|具体来说|简单说|一句话|回过头来|最后想|收个尾|结尾|补充一点)/u;

/** 找出 beat 区间内适合作为 step 锚点的 cue 下标（语义触发词优先）。 */
function findStepAnchorIndices(
  paired: Array<{ cue: SrtCue; line?: ScriptLineTiming }>,
  fromIndex: number,
  toIndex: number,
  count: number,
): number[] {
  const anchors: number[] = [];
  if (count <= 1) return anchors;

  const triggerHits: number[] = [];
  for (let i = fromIndex + 1; i < toIndex; i += 1) {
    const text = paired[i]?.line?.text || paired[i]?.cue.text || '';
    if (STEP_TRIGGER_RE.test(text)) triggerHits.push(i);
  }

  // 从命中里均匀取样；不足则按字重等分（含 toIndex，保证最后一个 target 可达）
  const needed = count - 1;
  const picks = [...triggerHits];
  if (picks.length < needed) {
    const spanWeight = paired
      .slice(fromIndex, toIndex + 1)
      .reduce((a, p) => a + charWeight(p.cue.text), 0);
    const targets: number[] = [];
    for (let k = 1; k <= needed; k += 1) targets.push((k * spanWeight) / needed);
    let acc = 0;
    let t = 0;
    // 累计从 fromIndex 起（含首条 cue 字重），使最后一个 target 必然可达
    for (let i = fromIndex; i <= toIndex && t < targets.length; i += 1) {
      acc += charWeight(paired[i].cue.text);
      if (i > fromIndex && acc >= targets[t]) {
        picks.push(i);
        t += 1;
      }
    }
  }
  const sorted = [...new Set(picks)].sort((a, b) => a - b);
  const step = sorted.length / needed;
  for (let k = 0; k < needed; k += 1) {
    const idx = sorted[Math.min(sorted.length - 1, Math.round(k * step))];
    if (idx > fromIndex && idx <= toIndex) anchors.push(idx);
  }
  return [...new Set(anchors)].sort((a, b) => a - b).slice(0, needed);
}

function charWeight(text: string): number {
  return Math.max(1, Array.from(String(text || '').replace(/\s+/gu, '')).length);
}

/* ---- 大纲 → beat 映射 ---- */

export interface StoryboardInput {
  title: string;
  cues: SrtCue[];
  lines?: ScriptLineTiming[];
  outline?: PodcastSegment[];
}

export interface StoryboardResult {
  beats: MotionBeat[];
  /** 每个 beat 覆盖的 cue 下标范围（含端点，基于 paired 数组） */
  notes: string[];
}

const MIN_BEAT_MS = 5_000;
const MAX_BEAT_MS = 30_000;
const MAX_BEATS = 16;
/** 空档超过该值时必须插入 broll beat 填充（与门禁 gapLimitMs 对齐） */
const BROLL_GAP_THRESHOLD_MS = 500;

/* ---- 屏幕文字提炼（屏幕文字短于口播，去开场白与语气词） ---- */

/** 常见开场白/口头禅前缀，命中即剥离 */
const OPENING_RE =
  /^(大家好|各位听众|各位朋友|欢迎收听|欢迎来到|欢迎回来|本期节目|本期聊聊|今天聊聊|今天来聊|今天我们|我们这期|我是[^，。！？]{1,12}|接下来|接下来我们|下面|那么今天|好，我们|好的，我们|感谢收听|谢谢收听)/u;

/** 提炼屏幕短标题：去开场白 → 压空白 → 截断（避免拆词），超长补省略号 */
function condenseTitle(raw: string, max = 26): string {
  let text = String(raw || '').replace(/\s+/gu, ' ').trim();
  if (!text) return '';
  const stripped = text.replace(OPENING_RE, '');
  if (stripped.trim()) text = stripped.trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  // 在 max-1 个字符内找最后的分隔标点，尽量整段截断
  const window = chars.slice(0, max - 1).join('');
  const seg = /^[\s\S]{0,24}[。；;，,、：:！？!?…—]/.exec(window);
  const cut = seg ? seg[0].trim().replace(/[，,、：:；;。！？!?…—]+$/u, '') : window;
  const clean = cut.trim();
  return clean.length >= 4 ? `${clean}…` : `${window}…`;
}

/** 短标题截断（屏幕文字短于口播；大纲标题保持原样，仅超长截断） */
function beatTitle(seg: PodcastSegment | undefined, fallback: string): string {
  const raw = seg?.title?.trim() || fallback.trim();
  if (seg?.title?.trim()) {
    const chars = Array.from(raw);
    return chars.length <= 26 ? raw : condenseTitle(raw, 26);
  }
  return condenseTitle(raw, 26);
}

/**
 * 构建分镜：
 * 1. 大纲每个 segment → 一个 beat（大纲缺失则按字重等分 4-8 段）；
 * 2. beat 边界钉在 anchor cue 的 startMs（末 beat 的 endMs = 主时钟总时长）；
 * 3. beat 内按语义触发词分 2-3 步，stepTimes = 各步首 cue 的 startMs；
 * 4. 末 beat 标记为收束页（closing）。
 */
export function buildStoryboard(input: StoryboardInput): StoryboardResult {
  const { title, cues } = input;
  const notes: string[] = [];
  const paired = alignCuesToLines(cues, input.lines || []);

  if (!cues.length) return { beats: [], notes: notes.concat('没有可用 cue，无法分镜') };

  // 0) 扫描 cue 级大空档（> 门限）：作为强制切分点，保证后续 broll 能填充，
  //    画面不会在口播停止时空等（skill：每个区间必须属于 motion 或 broll）。
  const bigGaps: Array<{ cutCue: number; gapStartMs: number; gapEndMs: number }> = [];
  for (let i = 0; i + 1 < cues.length; i += 1) {
    const gap = cues[i + 1].startMs - cues[i].endMs;
    if (gap > BROLL_GAP_THRESHOLD_MS) {
      bigGaps.push({ cutCue: i + 1, gapStartMs: cues[i].endMs, gapEndMs: cues[i + 1].startMs });
    }
  }
  const forcedCuts = bigGaps.map((g) => g.cutCue);
  if (bigGaps.length) {
    notes.push(
      `发现 ${bigGaps.length} 处 >${BROLL_GAP_THRESHOLD_MS}ms 静音，将切分为 B-roll 过渡`,
    );
  }

  // 1) 段落边界（cue 下标）
  const segments = input.outline?.length ? input.outline : null;
  const boundaries: Array<{ start: number; end: number; seg?: PodcastSegment }> = [];

  if (segments) {
    const anchors: number[] = [];
    const lastPaired = paired.length - 1;
    // 每个 segment 找一个代表 cue（标题 + 摘要与行文本最高重叠）
    let searchFrom = 0;
    for (const seg of segments) {
      const needle = `${seg.title || ''} ${seg.summary || ''}`.trim();
      let best = -1;
      let bestScore = 0;
      for (let i = searchFrom; i <= lastPaired; i += 1) {
        const text = paired[i]?.line?.text || paired[i]?.cue.text || '';
        const score = needle ? overlapScore(needle, text) : 0;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0 && bestScore > 0.12) {
        anchors.push(best);
        searchFrom = best + 1;
      } else {
        anchors.push(searchFrom);
      }
    }
    // 保证单调并去重，注入大空档强制切分点
    const unique: number[] = [];
    for (const a of [...anchors, ...forcedCuts]) {
      const lastAnchor = unique[unique.length - 1];
      if (lastAnchor === undefined || a > lastAnchor) unique.push(a);
    }
    if (!unique.length) unique.push(0);
    if (unique[unique.length - 1] !== lastPaired) unique.push(lastPaired);

    for (let i = 0; i < unique.length - 1; i += 1) {
      const start = unique[i];
      const rawEnd = i + 1 < unique.length - 1 ? unique[i + 1] - 1 : lastPaired;
      const end = Math.max(start, rawEnd);
      boundaries.push({
        start,
        end,
        seg: segments[Math.min(i, segments.length - 1)],
      });
    }
  } else {
    // 大纲缺失：按字重把 cue 均分 4-8 段，并注入大空档强制切分点
    notes.push('没有大纲，按字重把口播等分为 beat');
    const totalWeight = cues.reduce((a, c) => a + charWeight(c.text), 0);
    const beatCount = Math.min(
      MAX_BEATS,
      Math.max(4, Math.round(totalWeight / 420)),
    );
    const lastIdx = cues.length - 1;
    const cuts: number[] = [0];
    let acc = 0;
    let prevCut = 0;
    for (let i = 0; i < lastIdx; i += 1) {
      acc += charWeight(cues[i].text);
      const target = (prevCut + 1) * (totalWeight / beatCount);
      if (acc >= target && cuts.length < beatCount) {
        cuts.push(i);
        prevCut += 1;
      }
    }
    if (cuts[cuts.length - 1] !== lastIdx) cuts.push(lastIdx);
    // 注入强制切分点后重新切段
    const allCuts = [...cuts, ...forcedCuts]
      .filter((c) => c > 0 && c < lastIdx)
      .sort((a, b) => a - b);
    const uniqueCuts: number[] = [];
    for (const c of allCuts) {
      if (uniqueCuts[uniqueCuts.length - 1] !== c) uniqueCuts.push(c);
    }
    const finalCuts = [0, ...uniqueCuts, lastIdx];
    for (let i = 0; i < finalCuts.length - 1; i += 1) {
      boundaries.push({
        start: finalCuts[i],
        end: i + 1 < finalCuts.length - 1 ? finalCuts[i + 1] - 1 : lastIdx,
      });
    }
  }

  // 2) 合并过短 beat（< 5s 且非末段）；跨越 >500ms 大空档的两段禁止合并
  const merged: typeof boundaries = [];
  for (const b of boundaries) {
    const startMs = cues[b.start].startMs;
    const endMs = cues[b.end].endMs;
    const isLast = b === boundaries[boundaries.length - 1];
    const prev = merged[merged.length - 1] as { end: number } | undefined;
    const gapToPrev = prev === undefined ? 0 : startMs - cues[prev.end].endMs;
    if (
      !isLast &&
      prev !== undefined &&
      gapToPrev <= BROLL_GAP_THRESHOLD_MS &&
      endMs - cues[prev.end].endMs < MIN_BEAT_MS
    ) {
      merged[merged.length - 1].end = b.end;
      merged[merged.length - 1].seg = b.seg;
      notes.push(`合并短 beat（${endMs - startMs}ms < ${MIN_BEAT_MS}ms）`);
      continue;
    }
    merged.push({ ...b });
  }

  // 3) 生成 beat（末 beat 为收束页）
  const durationMs = cues[cues.length - 1].endMs;
  const beats: MotionBeat[] = [];
  merged.forEach((b, i) => {
    const isClosing = i === merged.length - 1;
    const startMs = cues[b.start].startMs;
    const endMs = isClosing ? durationMs : cues[b.end].endMs;
    const kind: MotionBeatKind = isClosing ? 'closing' : 'motion';
    const fallbackTitle = isClosing
      ? `总结 · ${title || '本期'}`
      : shortTitleFromCues(cues, b.start, b.end);
    const titleText = beatTitle(b.seg, fallbackTitle);

    // 4) steps：按口播节奏分 2-5 步揭示，锚点钉在语义触发 cue 的 startMs
    const beatMs = endMs - startMs;
    const cueCount = b.end - b.start + 1;
    const stepCount = Math.min(5, Math.max(2, Math.round(beatMs / 7_000) + 1, cueCount));
    const anchorIdx = findStepAnchorIndices(paired, b.start, b.end, stepCount);
    const stepTimes = anchorIdx.map((idx) => cues[idx].startMs);
    const stepLabels: string[] = anchorIdx
      .map((idx) => shortTitleFromCues(cues, idx, Math.min(idx + 1, b.end), 18))
      .filter((label): label is string => Boolean(label));

    beats.push({
      id: `b${i + 1}`,
      kind,
      title: titleText,
      detail: b.seg?.summary || undefined,
      startMs,
      endMs,
      stepTimes,
      stepLabels,
      cueRange: [b.start + 1, b.end + 1],
    });
  });

  // 5) 大空档 → broll beat：门禁允许空档 ≤500ms，更大的静音段（真实播客常见
  //    段落停顿/音乐）填充为正式 broll beat，避免 P3.5 误伤并给录屏留呼吸。
  const withBroll: MotionBeat[] = [];
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    withBroll.push(beat);
    const next = beats[i + 1];
    if (!next) continue;
    const gapStart = beat.endMs;
    const gapEnd = next.startMs;
    const gap = gapEnd - gapStart;
    if (gap <= BROLL_GAP_THRESHOLD_MS) continue;
    // broll 标题 = 之后内容的预告（取下一 beat 首条 cue 提炼），长度 < gap 时长/8 字/秒
    const nextFirstCueIdx = (next.cueRange?.[0] ?? 1) - 1;
    const cue = cues[nextFirstCueIdx];
    const title = cue
      ? condenseTitle(cue.text, Math.max(8, Math.min(20, Math.floor(gap / 1_000))))
      : '过渡';
    withBroll.push({
      id: `b${withBroll.length + 1}`,
      kind: 'broll',
      title,
      startMs: gapStart,
      endMs: gapEnd,
      stepTimes: [],
      cueRange: [0, 0],
      brollSilence: { gapStartMs: gapStart, gapEndMs: gapEnd },
    });
    notes.push(
      `静音 ${gap}ms > ${BROLL_GAP_THRESHOLD_MS}ms：插入 B-roll「${title}」（${gapStart}–${gapEnd}ms）`,
    );
  }

  // 重新编号，保证 id 连续稳定（收束页始终为最后一个）
  const finalBeats = withBroll.map((b, i) => ({ ...b, id: `b${i + 1}` }));
  return { beats: finalBeats, notes };
}

function shortTitleFromCues(cues: SrtCue[], from: number, to: number, max = 20): string {
  const text = cues
    .slice(from, to + 1)
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return condenseTitle(text, max);
}
