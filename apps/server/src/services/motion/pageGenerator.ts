import type {
  Job,
  MotionBeat,
  MotionPageSpec,
  MotionScene,
  MotionSceneLayout,
} from '@bokebox/shared';
import { aiFetch, getChatModel, hasApiKey } from '../../utils/aiConfig.js';

const PALETTE = ['#8b5cf6', '#22d3ee', '#f59e0b', '#f472b6', '#34d399', '#60a5fa'];
const LAYOUTS: MotionSceneLayout[] = ['hero', 'split', 'steps', 'quote', 'closing'];

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

function fallbackScene(beat: MotionBeat, index: number): MotionScene {
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
  return {
    beatId: beat.id,
    layout,
    eyebrow: beat.kind === 'broll' ? 'PAUSE / TRANSITION' : beat.kind === 'closing' ? 'TAKEAWAY' : `PART ${String(index + 1).padStart(2, '0')}`,
    title: clean(beat.title, 72),
    body: beat.kind === 'broll' ? '让信息留出呼吸，也让下一段观点自然进入。' : '',
    bullets,
    accent: PALETTE[index % PALETTE.length],
  };
}

function fallbackPage(beats: MotionBeat[], prompt?: string): MotionPageSpec {
  return {
    version: 1,
    source: 'fallback',
    prompt: prompt?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    scenes: beats.map(fallbackScene),
  };
}

function normalizePage(
  raw: Record<string, unknown>,
  beats: MotionBeat[],
  prompt?: string,
): MotionPageSpec | null {
  const values = Array.isArray(raw.scenes) ? raw.scenes : [];
  const byId = new Map(
    values
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => [clean(item.beatId, 64), item]),
  );
  const scenes = beats.map((beat, index) => {
    const item = byId.get(beat.id) || values[index];
    const fallback = fallbackScene(beat, index);
    if (!item || typeof item !== 'object') return fallback;
    const value = item as Record<string, unknown>;
    const bullets = Array.isArray(value.bullets)
      ? value.bullets.map((bullet) => clean(bullet, 80)).filter(Boolean).slice(0, 4)
      : fallback.bullets;
    const layout = LAYOUTS.includes(value.layout as MotionSceneLayout)
      ? value.layout as MotionSceneLayout
      : fallback.layout;
    return {
      beatId: beat.id,
      layout,
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
  if (!hasApiKey('llm')) return fallbackPage(beats, prompt);

  const outline = (job.podcast?.outline || [])
    .map((item, index) => `${index + 1}. ${item.title}：${item.summary}`)
    .join('\n');
  const beatBrief = beats.map((beat, index) => ({
    beatId: beat.id,
    index,
    kind: beat.kind,
    title: beat.title,
    stepLabels: beat.stepLabels || [],
  }));
  const system = [
    '你是资深信息设计师，为播客口播稿生成可直接在线预览的 16:9 Motion 页面内容。',
    '只输出严格 JSON，不要 markdown，不要解释。',
    '必须返回 {"scenes":[...]}，且每个 beatId 都只能对应一个 scene。',
    '不要改变 beatId、时间、顺序；不要编造口播稿以外的事实。',
    '页面要像 Apple / 字节产品发布会：克制、留白、强层级，短标题优先。',
    'layout 只能是 hero、split、steps、quote、closing；bullets 最多 4 条；每条短于 24 个汉字。',
    'body 是补充解释，最多 80 个汉字；eyebrow 最多 12 个汉字。',
  ].join('\n');
  const user = [
    `标题：${job.podcast?.title || job.title}`,
    `额外视觉要求：${prompt?.trim() || '默认做成现代、清晰、适合录屏的知识信息动画。'}`,
    `节目大纲：\n${outline || '无'}`,
    `口播稿：\n${(job.podcast?.script || '').slice(0, 14000)}`,
    `固定时间轴分镜：\n${JSON.stringify(beatBrief)}`,
    '请根据口播稿为这些固定分镜填写页面内容。',
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
  const page = normalizePage(parseJson(content) || {}, beats, prompt);
  if (!page) throw new Error('Motion AI 返回的页面结构无法解析');
  return page;
}
