import type {
  Job,
  MotionBeat,
  MotionPageSpec,
  MotionPageStyle,
  MotionPalette,
  MotionPrimitive,
  MotionScene,
  MotionSceneMotion,
  MotionSceneLayout,
  MotionSceneVariant,
  MotionStyleOptions,
  MotionVisual,
} from '@bokebox/shared';
import {
  DEFAULT_MOTION_STYLE_OPTIONS as DEFAULT_STYLE_OPTIONS,
  normalizeMotionStyleOptions,
} from '@bokebox/shared';
import { aiFetch, getChatModel, hasApiKey } from '../../utils/aiConfig.js';

const STYLE_IDS: MotionPageStyle[] = [
  'apple-tech-gradient',
  'editorial-magazine',
  'sketch-note',
  'finance-studio-cards',
  'newspaper-evidence',
  'paper-collage',
];
const STYLE_ACCENTS: Record<MotionPageStyle, string> = {
  'apple-tech-gradient': '#e85d36',
  'editorial-magazine': '#b91c1c',
  'sketch-note': '#d92d20',
  'finance-studio-cards': '#2dd4bf',
  'newspaper-evidence': '#b91c1c',
  'paper-collage': '#e85d36',
};
const STYLE_ACCENT_PAIRS: Record<MotionPageStyle, [string, string]> = {
  'apple-tech-gradient': ['#e85d36', '#fbbf24'],
  'editorial-magazine': ['#b91c1c', '#f59e0b'],
  'sketch-note': ['#d92d20', '#2563eb'],
  'finance-studio-cards': ['#2dd4bf', '#38bdf8'],
  'newspaper-evidence': ['#b91c1c', '#0f766e'],
  'paper-collage': ['#e85d36', '#7c3aed'],
};
const PALETTE_ACCENT_PAIRS: Record<Exclude<MotionPalette, 'auto'>, [string, string]> = {
  warm: ['#f97316', '#facc15'],
  cool: ['#22d3ee', '#6366f1'],
  neon: ['#f43f5e', '#a855f7'],
  monochrome: ['#f4f4f5', '#71717a'],
  paper: ['#b45309', '#0f766e'],
};
const LAYOUTS: MotionSceneLayout[] = ['hero', 'split', 'steps', 'quote', 'closing'];
const PRIMITIVES: MotionPrimitive[] = ['Claim', 'Contrast', 'Path', 'System', 'Evidence'];
const VISUALS: MotionVisual[] = [
  'claim-lockup',
  'split-compare',
  'path-build',
  'system-layer-expand',
  'number-count',
  'quote-lock',
];
const VARIANTS: MotionSceneVariant[] = [
  'hook-slam',
  'diagonal-reveal',
  'signal-bars',
  'before-after',
  'stack-cascade',
  'quote-cut',
  'ticker-drive',
  'closing-lock',
];
const MOTIONS: MotionSceneMotion[] = [
  'slam',
  'wipe',
  'scan',
  'cascade',
  'drift',
  'type-on',
  'pulse',
];

function inferStyle(prompt: string | undefined, jobText: string): MotionPageStyle {
  const text = `${prompt || ''} ${jobText}`.toLowerCase();
  if (/手绘|草图|教程|科普|入门|步骤|怎么做|方法/u.test(text)) return 'sketch-note';
  if (/数据|财报|商业|增长|市场|指标|收入|成本/u.test(text)) return 'finance-studio-cards';
  if (/新闻|历史|案例|证据|事实|调查/u.test(text)) return 'newspaper-evidence';
  if (/清单|测评|经验|生活|种草|推荐/u.test(text)) return 'paper-collage';
  if (/观点|文化|深度|研究|洞察/u.test(text)) return 'editorial-magazine';
  return 'apple-tech-gradient';
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function resolvedStyleOptions(value?: MotionStyleOptions): MotionStyleOptions {
  return normalizeMotionStyleOptions(value) || { ...DEFAULT_STYLE_OPTIONS };
}

function accentPairFor(style: MotionPageStyle, palette: MotionPalette): [string, string] {
  return palette === 'auto'
    ? STYLE_ACCENT_PAIRS[style]
    : PALETTE_ACCENT_PAIRS[palette];
}

function fallbackVariant(beat: MotionBeat, index: number): MotionSceneVariant {
  if (beat.kind === 'closing') return 'closing-lock';
  if (beat.kind === 'broll') return 'diagonal-reveal';
  if (index === 0) return 'hook-slam';
  if (/\d|百分比|增长|减少/u.test(beat.title)) return 'signal-bars';
  if (beat.stepLabels && beat.stepLabels.length > 1) return 'stack-cascade';
  const contentVariants: MotionSceneVariant[] = [
    'before-after',
    'quote-cut',
    'ticker-drive',
    'diagonal-reveal',
  ];
  return contentVariants[(index - 1) % contentVariants.length];
}

function fallbackMotion(variant: MotionSceneVariant, index: number): MotionSceneMotion {
  const byVariant: Partial<Record<MotionSceneVariant, MotionSceneMotion>> = {
    'hook-slam': 'slam',
    'diagonal-reveal': 'wipe',
    'signal-bars': 'scan',
    'before-after': 'drift',
    'stack-cascade': 'cascade',
    'quote-cut': 'type-on',
    'ticker-drive': 'pulse',
    'closing-lock': 'slam',
  };
  return byVariant[variant] || MOTIONS[index % MOTIONS.length];
}

function normalizedVariant(
  value: unknown,
  fallback: MotionSceneVariant,
  previous?: MotionSceneVariant,
  beatKind?: MotionBeat['kind'],
): MotionSceneVariant {
  const candidate = VARIANTS.includes(value as MotionSceneVariant)
    ? value as MotionSceneVariant
    : fallback;
  if (beatKind === 'closing') return 'closing-lock';
  if (candidate !== previous) return candidate;
  const available = VARIANTS.filter((item) => item !== 'closing-lock' && item !== previous);
  return available[0] || candidate;
}

function parseJson(text: string): Record<string, unknown> | null {
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(source) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(source.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

function fallbackScene(
  beat: MotionBeat,
  index: number,
  style: MotionPageStyle,
  styleOptions: MotionStyleOptions,
): MotionScene {
  const bullets = beat.kind === 'broll'
    ? []
    : (beat.stepLabels?.length ? beat.stepLabels : [beat.title]).slice(0, 4);
  const layout: MotionSceneLayout = beat.kind === 'closing'
    ? 'closing'
    : beat.kind === 'broll'
      ? 'quote'
      : index === 0
        ? 'hero'
        : bullets.length > 1
          ? 'steps'
          : 'split';
  const primitive: MotionPrimitive = beat.kind === 'closing'
    ? 'Claim'
    : bullets.length > 1
      ? 'Path'
      : /\d|百分比|增长|减少/u.test(beat.title)
        ? 'Evidence'
        : 'Claim';
  const visual: MotionVisual = beat.kind === 'closing'
    ? 'quote-lock'
    : primitive === 'Path'
      ? 'path-build'
      : primitive === 'Evidence'
        ? 'number-count'
        : layout === 'split'
          ? 'split-compare'
          : 'claim-lockup';
  const variant = fallbackVariant(beat, index);
  const [accent, accent2] = accentPairFor(style, styleOptions.palette);
  return {
    beatId: beat.id,
    layout,
    primitive,
    visual,
    eyebrow: beat.kind === 'broll' ? 'PAUSE / TRANSITION' : beat.kind === 'closing' ? 'TAKEAWAY' : `PART ${String(index + 1).padStart(2, '0')}`,
    title: clean(beat.title, 72),
    body: beat.kind === 'broll' ? '让信息留出呼吸，也让下一段观点自然进入。' : '',
    bullets,
    accent,
    accent2,
    variant,
    motion: fallbackMotion(variant, index),
  };
}

function fallbackPage(
  beats: MotionBeat[],
  prompt: string | undefined,
  jobText: string,
  styleOptions?: MotionStyleOptions,
): MotionPageSpec {
  const options = resolvedStyleOptions(styleOptions);
  const style = options.preset === 'auto' ? inferStyle(prompt, jobText) : options.preset;
  return {
    version: 1,
    source: 'fallback',
    style,
    styleOptions: options,
    styleReason: options.preset === 'auto'
      ? '根据内容关键词选择色彩基底，再为每个 beat 生成不同构图与入场节奏。'
      : '按结构化风格选项锁定视觉基底，再为每个 beat 生成不同构图与入场节奏。',
    prompt: prompt?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    scenes: beats.map((beat, index) => fallbackScene(beat, index, style, options)),
  };
}

function normalizePage(
  raw: Record<string, unknown>,
  beats: MotionBeat[],
  prompt?: string,
  fallbackStyle: MotionPageStyle = 'apple-tech-gradient',
  styleOptions?: MotionStyleOptions,
): MotionPageSpec | null {
  const options = resolvedStyleOptions(styleOptions);
  const values = Array.isArray(raw.scenes) ? raw.scenes : [];
  const style = options.preset !== 'auto'
    ? options.preset
    : STYLE_IDS.includes(raw.style as MotionPageStyle)
    ? raw.style as MotionPageStyle
    : fallbackStyle;
  const byId = new Map(
    values
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => [clean(item.beatId, 64), item]),
  );
  let previousVariant: MotionSceneVariant | undefined;
  const scenes = beats.map((beat, index) => {
    const item = byId.get(beat.id) || values[index];
    const fallback = fallbackScene(beat, index, style, options);
    if (!item || typeof item !== 'object') {
      previousVariant = fallback.variant;
      return fallback;
    }
    const value = item as Record<string, unknown>;
    const bullets = Array.isArray(value.bullets)
      ? value.bullets.map((bullet) => clean(bullet, 80)).filter(Boolean).slice(0, 4)
      : fallback.bullets;
    const layout = LAYOUTS.includes(value.layout as MotionSceneLayout)
      ? value.layout as MotionSceneLayout
      : fallback.layout;
    const primitive = PRIMITIVES.includes(value.primitive as MotionPrimitive)
      ? value.primitive as MotionPrimitive
      : fallback.primitive;
    const visual = VISUALS.includes(value.visual as MotionVisual)
      ? value.visual as MotionVisual
      : fallback.visual;
    const variant = normalizedVariant(value.variant, fallback.variant || fallbackVariant(beat, index), previousVariant, beat.kind);
    previousVariant = variant;
    const motion = MOTIONS.includes(value.motion as MotionSceneMotion)
      ? value.motion as MotionSceneMotion
      : fallbackMotion(variant, index);
    return {
      beatId: beat.id,
      layout,
      primitive,
      visual,
      variant,
      motion,
      eyebrow: clean(value.eyebrow, 36) || fallback.eyebrow,
      title: clean(value.title, 72) || fallback.title,
      body: clean(value.body, 180),
      bullets,
      accent: options.palette === 'auto' && /^#[0-9a-f]{6}$/i.test(String(value.accent || ''))
        ? String(value.accent)
        : fallback.accent,
      accent2: options.palette === 'auto' && /^#[0-9a-f]{6}$/i.test(String(value.accent2 || ''))
        ? String(value.accent2)
        : fallback.accent2,
    };
  });
  return scenes.length ? {
    version: 1,
    source: 'ai',
    style,
    styleOptions: options,
    styleReason: clean(raw.styleReason, 120) || undefined,
    prompt: prompt?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    scenes,
  } : null;
}

/**
 * 让模型只负责“画面内容与编排”，不允许改写时间轴。
 * 没有 LLM 配置时保留可用的确定性页面，避免 Motion 退化成空白状态。
 */
export async function generateMotionPage(
  job: Job,
  beats: MotionBeat[],
  prompt?: string,
  styleOptions?: MotionStyleOptions,
): Promise<MotionPageSpec> {
  const jobText = `${job.podcast?.title || job.title} ${(job.podcast?.tags || []).join(' ')}`;
  const options = resolvedStyleOptions(styleOptions);
  const fallbackStyle = options.preset === 'auto' ? inferStyle(prompt, jobText) : options.preset;
  if (!hasApiKey('llm')) return fallbackPage(beats, prompt, jobText, options);

  const outline = (job.podcast?.outline || [])
    .map((item, index) => `${index + 1}. ${item.title}：${item.summary}`)
    .join('\n');
  const beatBrief = beats.map((beat, index) => ({
    beatId: beat.id,
    chapterId: beat.chapterId,
    index,
    kind: beat.kind,
    title: beat.title,
    stepLabels: beat.stepLabels || [],
  }));
  const system = [
    '你是资深 B 站信息动画导演，为播客口播稿生成可直接录屏的 16:9 Motion 页面内容。',
    '只输出严格 JSON，不要 markdown，不要解释。',
    '必须返回 {"scenes":[...]}，且每个 beatId 都只能对应一个 scene；全片 scene 数量必须与输入的所有章节 beat 完全一致。',
    '不要改变 beatId、时间、顺序；不要编造口播稿以外的事实。',
    '先为整集选择一个 style：apple-tech-gradient、editorial-magazine、sketch-note、finance-studio-cards、newspaper-evidence、paper-collage；style 只是色彩与材质基底，不是固定模板。',
    '一章只对应一张主视觉页；拒绝 dashboard、中心大圆、胶囊节点环绕、三张等宽卡片、随机散点和拥挤卡片墙；每页只保留一个第一眼主视觉。',
    '每个 scene 必须包含 primitive（Claim/Contrast/Path/System/Evidence）和 visual（claim-lockup/split-compare/path-build/system-layer-expand/number-count/quote-lock）。',
    '每个 scene 还必须包含 variant：hook-slam、diagonal-reveal、signal-bars、before-after、stack-cascade、quote-cut、ticker-drive、closing-lock 之一；相邻 scene 不得使用同一 variant。',
    '每个 scene 还必须包含 motion：slam、wipe、scan、cascade、drift、type-on、pulse 之一；这是入场编排，不是装饰标签。',
    '页面要像真正的信息动画，不要像表格或 PPT：开头 1 秒先给爆点，标题巨大且可读，视觉只服务一个观点，底部和左右保留安全区。',
    'layout 只能是 hero、split、steps、quote、closing；bullets 最多 4 条；每条短于 24 个汉字。',
    'body 是补充解释，最多 80 个汉字；eyebrow 最多 12 个汉字；accent 和 accent2 必须是 #RRGGBB。',
    `结构化选项必须服从：${JSON.stringify(options)}。preset 不是 auto 时，顶层 style 必须使用指定值；其余选项会由渲染器强制落实到配色、排版、信息密度和动效节奏。`,
  ].join('\n');
  const user = [
    `标题：${job.podcast?.title || job.title}`,
    `额外视觉要求：${prompt?.trim() || '默认做成适合 B 站录屏的高对比知识信息动画，前 1 秒给出视觉爆点，镜头之间明显换构图。'}`,
    `结构化风格选项：${JSON.stringify(options)}`,
    `节目大纲：\n${outline || '无'}`,
    `口播稿：\n${(job.podcast?.script || '').slice(0, 14000)}`,
    `固定时间轴分镜：\n${JSON.stringify(beatBrief)}`,
    '请根据口播稿为这些按内容长度生成的分镜填写页面内容。style 放在顶层，styleReason 说明色彩基底；variant 和 motion 说明每页如何与上一页拉开差异。',
  ].join('\n\n');
  const body = {
    model: getChatModel(),
    temperature: 0.55,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  let response = await aiFetch('/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const lower = errorText.toLowerCase();
    if (response.status !== 400 || (!lower.includes('response_format') && !lower.includes('json_object'))) {
      throw new Error(`Motion AI 生成失败 (${response.status}): ${errorText.slice(0, 240)}`);
    }
    const { response_format: _drop, ...fallbackBody } = body;
    response = await aiFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(fallbackBody),
    });
  }
  if (!response.ok) {
    throw new Error(`Motion AI 生成失败 (${response.status})`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || '';
  const page = normalizePage(parseJson(content) || {}, beats, prompt, fallbackStyle, options);
  if (!page) throw new Error('Motion AI 返回的页面结构无法解析');
  return page;
}
