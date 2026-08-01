/**
 * Motion 模式 API
 *
 * GET  /jobs/:id/motion/timeline  → 已确认时间轴（含覆盖表 + 门禁状态）
 * POST /jobs/:id/motion/draft     → 优化 SRT + 分镜 + P3.5 门禁预检（不落盘）
 * POST /jobs/:id/motion/generate  → 根据口播稿调用 AI 生成页面并保存
 * POST /jobs/:id/motion/confirm   → 确认时间轴（门禁通过才落盘）
 * POST /jobs/:id/motion/build     → 用已确认时间轴（重新）装配 HTML
 * GET  /jobs/:id/motion.html      → 下载生成的信息动画 HTML
 * GET  /jobs/:id/motion.srt       → 下载优化后的 SRT（毫秒级主时钟原料）
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { jobPaths } from '../../utils/paths.js';
import { getJob, isPubliclyListenable } from '../../services/job/jobStore.js';
import { getRequestUser } from '../auth.js';
import { pathExists } from '../../utils/fs.js';
import { sendMedia } from './helpers.js';
import { getRequestLocale, t } from '../../i18n/index.js';
import {
  normalizeMotionStyleOptions,
  type MotionBeat,
} from '@bokebox/shared';
import { ApiErrorCode, fail } from '../../utils/apiResponse.js';
import {
  buildFromConfirmed,
  confirmAndBuild,
  draftTimeline,
  generateAndBuild,
  readConfirmedTimeline,
} from '../../services/motion/index.js';
import { loadOptimizedSrt } from '../../services/motion/srtOptimizer.js';

const MOTION_BEAT_MAX = 16;

function isMotionBeat(value: unknown): value is MotionBeat {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  if (typeof b.id !== 'string') return false;
  if (b.kind !== 'motion' && b.kind !== 'broll' && b.kind !== 'closing') return false;
  if (typeof b.title !== 'string') return false;
  if (typeof b.startMs !== 'number' || typeof b.endMs !== 'number') return false;
  if (!Number.isFinite(b.startMs) || !Number.isFinite(b.endMs)) return false;
  if (b.endMs <= b.startMs) return false;
  if (!Array.isArray(b.stepTimes)) return false;
  if (!Array.isArray(b.cueRange) || b.cueRange.length !== 2) return false;
  return (b.stepTimes as unknown[]).every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** 写操作需要登录（游客只读下载已确认产物） */
function requireUser(req: import('fastify').FastifyRequest): boolean {
  return Boolean(getRequestUser(req));
}

export async function motionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/jobs/:id/motion/timeline', async (req, reply) => {
    const job = await getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
    if (!requireUser(req) && !isPubliclyListenable(job)) {
      return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
    }
    const timeline = await readConfirmedTimeline(job.id);
    return {
      ok: true,
      hasTimeline: Boolean(timeline),
      timeline,
      durationMs: timeline?.durationMs ?? 0,
      beats: timeline?.beats ?? [],
    };
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/motion/draft', async (req, reply) => {
    if (!requireUser(req)) return reply.code(401).send({ error: t(getRequestLocale(req), 'auth.notLoggedIn') });
    const job = await getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
    const draft = await draftTimeline(job);
    if (!draft.ok) {
      // 统一信封 + 详情放 data：门禁违规明细（violations / rows）必须能透传前端
      return reply.code(422).send({
        code: 422,
        message: t(
          getRequestLocale(req),
          draft.error === 'missing-srt' ? 'job.motionSrtMissing' : 'job.motionGateFailed',
        ),
        data: {
          error: draft.error || 'gate-failed',
          title: draft.title,
          gate: draft.gate,
          rows: draft.rows,
          beats: draft.beats,
          durationMs: draft.durationMs,
          notes: draft.notes,
          srtInfo: draft.srtInfo,
        },
        errorCode: ApiErrorCode.GATE_FAILED,
      });
    }
    return {
      ok: true,
      title: draft.title,
      gate: draft.gate,
      rows: draft.rows,
      beats: draft.beats,
      durationMs: draft.durationMs,
      notes: draft.notes,
      srtInfo: draft.srtInfo,
    };
  });

  app.post<{ Params: { id: string }; Body: { prompt?: unknown; styleOptions?: unknown } }>(
    '/jobs/:id/motion/generate',
    async (req, reply) => {
      if (!requireUser(req)) return reply.code(401).send({ error: t(getRequestLocale(req), 'auth.notLoggedIn') });
      const job = await getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0, 800) : undefined;
      const styleOptions = normalizeMotionStyleOptions(req.body?.styleOptions);
      try {
        const result = await generateAndBuild(job, prompt, styleOptions);
        if (!result.ok) {
          return reply.code(422).send({
            code: 422,
            message: t(
              getRequestLocale(req),
              result.error === 'missing-srt' ? 'job.motionSrtMissing' : 'job.motionGateFailed',
            ),
            data: { error: result.error || 'gate-failed', gate: result.gate, timeline: result.timeline },
            errorCode: ApiErrorCode.GATE_FAILED,
          });
        }
        return { ok: true, timeline: result.timeline, html: result.html };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({
          code: 502,
          message,
          errorCode: ApiErrorCode.INTERNAL_ERROR,
        });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { beats?: unknown } }>(
    '/jobs/:id/motion/confirm',
    async (req, reply) => {
      if (!requireUser(req)) return reply.code(401).send({ error: t(getRequestLocale(req), 'auth.notLoggedIn') });
      const job = await getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
      const rawBeats = req.body?.beats;
      if (!Array.isArray(rawBeats) || rawBeats.length === 0 || rawBeats.length > MOTION_BEAT_MAX) {
        return reply.code(400).send(fail(400, `beats 必须是非空数组（≤${MOTION_BEAT_MAX}）`, ApiErrorCode.BAD_REQUEST));
      }
      if (!rawBeats.every(isMotionBeat)) {
        return reply.code(400).send(fail(400, 'beats 字段不完整', ApiErrorCode.BAD_REQUEST));
      }
      const beats = rawBeats as MotionBeat[];
      const result = await confirmAndBuild(job, beats);
      if (!result.ok) {
        return reply.code(422).send({
          code: 422,
          message: t(
            getRequestLocale(req),
            result.error === 'missing-srt' ? 'job.motionSrtMissing' : 'job.motionGateFailed',
          ),
          data: { error: result.error || 'gate-failed', gate: result.gate, timeline: result.timeline },
          errorCode: ApiErrorCode.GATE_FAILED,
        });
      }
      return { ok: true, timeline: result.timeline, html: result.html };
    },
  );

  app.post<{ Params: { id: string } }>('/jobs/:id/motion/build', async (req, reply) => {
    if (!requireUser(req)) return reply.code(401).send({ error: t(getRequestLocale(req), 'auth.notLoggedIn') });
    const job = await getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
    const result = await buildFromConfirmed(job);
    if (!result.ok) {
      return reply.code(422).send({
        code: 422,
        message: t(getRequestLocale(req), 'job.motionGateFailed'),
        data: { error: result.error || 'no-confirmed-timeline', gate: result.gate, timeline: result.timeline },
        errorCode: result.error === 'html-invalid' ? ApiErrorCode.INTERNAL_ERROR : ApiErrorCode.GATE_FAILED,
      });
    }
    return { ok: true, timeline: result.timeline, html: result.html };
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/jobs/:id/motion.html',
    async (req, reply) => {
      const job = await getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
      if (!requireUser(req) && !isPubliclyListenable(job)) {
        return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
      }
      let file = jobPaths(job.id).motionHtml;
      if (!(await pathExists(file))) {
        return reply.code(404).send({ error: t(getRequestLocale(req), 'job.motionHtmlMissing') });
      }
      // 旧版本 HTML 没有声音解锁入口；首次打开时按已确认时间轴补装，避免用户必须重新生成页面。
      try {
        const currentHtml = await fs.readFile(file, 'utf8');
        if (!currentHtml.includes('id="motionAudio"') || !currentHtml.includes('id="audioUnlock"')) {
          const rebuilt = await buildFromConfirmed(job);
          if (rebuilt.ok && rebuilt.html?.file) {
            file = rebuilt.html.file;
          }
        }
      } catch {
        // 兼容旧任务：补装失败时仍返回已有 HTML，让原有预览行为保持可用。
      }
      const baseName = (job.podcast?.title || job.title || job.id).replace(/[\\/:*?"<>|]/g, '_');
      return sendMedia(req, reply, file, `${baseName}-motion.html`, req.query.download === '1');
    },
  );

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/jobs/:id/motion.srt',
    async (req, reply) => {
      const job = await getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
      if (!requireUser(req) && !isPubliclyListenable(job)) {
        return reply.code(404).send({ error: t(getRequestLocale(req), 'job.notFound') });
      }
      // 下载是只读出口：不在游客 GET 中触发旧任务的音频恢复或写文件。
      const srt = await loadOptimizedSrt(job.id);
      const body = srt?.optimizedSrtText;
      if (!body) {
        return reply.code(404).send({ error: t(getRequestLocale(req), 'job.srtMissing') });
      }
      const baseName = (job.podcast?.title || job.title || job.id).replace(/[\\/:*?"<>|]/g, '_');
      reply.header('Content-Type', 'application/x-subrip; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}-motion.srt`)}`);
      return body;
    },
  );
}
