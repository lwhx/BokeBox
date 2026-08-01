import type {
  Job,
  MotionBeat,
  MotionPageSpec,
  MotionPageStyle,
  MotionPrimitive,
  MotionScene,
  MotionSceneLayout,
  MotionVisual,
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

function fallbackScene(beat: MotionBeat, index: number, style: MotionPageStyle): MotionScene {
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
  return {
    beatId: beat.id,
    layout,
    primitive,
    visual,
    eyebrow: beat.kind === 'broll' ? 'PAUSE / TRANSITION' : beat.kind === 'closing' ? 'TAKEAWAY' : `PART ${String(index + 1).padStart(2, '0')}`,
    title: clean(beat.title, 72),
    body: beat.kind === 'broll' ? '让信息留出呼吸，也让下一段观点自然进入。' : '',
    bullets,
    accent: STYLE_ACCENTS[style],
  };
}

function fallbackPage(beats: MotionBeat[], prompt: string | undefined, jobText: string): MotionPageSpec {
  const style = inferStyle(prompt, jobText);
  return {
    version: 1,
    source: 'fallback',
    style,
    styleReason: '根据内容关键词选择稳定的单一视觉风格。',
    prompt: prompt?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    scenes: beats.map((beat, index) => fallbackScene(beat, index, style)),
  };
}

function normalizePage(
  raw: Record<string, unknown>,
  beats: MotionBeat[],
  prompt?: string,
  fallbackStyle: MotionPageStyle = 'apple-tech-gradient',
): MotionPageSpec | null {
  const values = Array.isArray(raw.scenes) ? raw.scenes : [];
  const style = STYLE_IDS.includes(raw.style as MotionPageStyle)
    ? raw.style as MotionPageStyle
    : fallbackStyle;
  const byId = new Map(
    values
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => [clean(item.beatId, 64), item]),
  );
  const scenes = beats.map((beat, index) => {
    const item = byId.get(beat.id) || values[index];
    const fallback = fallbackScene(beat, index, style);
    if (!item || typeof item !== 'object') return fallback;
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
    return {
      beatId: beat.id,
      layout,
      primitive,
      visual,
      eyebrow: clean(value.eyebrow, 36) || fallback.eyebrow,
      title: clean(value.title, 72) || fallback.title,
      body: clean(value.body, 180),
      bullets,
      accent: /^#[0-9a-f]{6}$/i.test(String(value.accent || ''))
        ? String(value.accent)
        : fallback.accent,
    };
  });
  return scenes.length ? {
    version: 1,
    source: 'ai',
    style,
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
): Promise<MotionPageSpec> {
  const jobText = `${job.podcast?.title || job.title} ${(job.podcast?.tags || []).join(' ')}`;
  const fallbackStyle = inferStyle(prompt, jobText);
  if (!hasApiKey('llm')) return fallbackPage(beats, prompt, jobText);

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
    '你是资深信息设计师，为播客口播稿生成可直接在线预览的 16:9 Motion 页面内容。',
    '只输出严格 JSON，不要 markdown，不要解释。',
    '必须返回 {"scenes":[...]}，且每个 beatId 都只能对应一个 scene；全片 scene 数量必须与 2-3 个章节 beat 完全一致。',
    '不要改变 beatId、时间、顺序；不要编造口播稿以外的事实。',
    '先为整集选择一个 style：apple-tech-gradient、editorial-magazine、sketch-note、finance-studio-cards、newspaper-evidence、paper-collage。全片只能使用一个风格。',
    '一章只对应一张主视觉页；拒绝 dashboard、中心大圆、胶囊节点环绕、三张等宽卡片和随机散点；每页只保留一个第一眼主视觉。',
    '每个 scene 必须包含 primitive（Claim/Contrast/Path/System/Evidence）和 visual（claim-lockup/split-compare/path-build/system-layer-expand/number-count/quote-lock）。',
    '页面要像真正的信息动画，不要像表格或 PPT：留白、强层级、一个主视觉、短标题优先。',
    'layout 只能是 hero、split、steps、quote、closing；bullets 最多 4 条；每条短于 24 个汉字。',
    'body 是补充解释，最多 80 个汉字；eyebrow 最多 12 个汉字。',
  ].join('\n');
  const user = [
    `标题：${job.podcast?.title || job.title}`,
    `额外视觉要求：${prompt?.trim() || '默认做成现代、清晰、适合录屏的知识信息动画。'}`,
    `节目大纲：\n${outline || '无'}`,
    `口播稿：\n${(job.podcast?.script || '').slice(0, 14000)}`,
    `固定时间轴分镜：\n${JSON.stringify(beatBrief)}`,
    '请根据口播稿为这些固定分镜填写页面内容。style 放在顶层，styleReason 说明为什么选它。',
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
  const page = normalizePage(parseJson(content) || {}, beats, prompt, fallbackStyle);
  if (!page) throw new Error('Motion AI 返回的页面结构无法解析');
  return page;
}
