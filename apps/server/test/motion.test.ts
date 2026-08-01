import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCoverageRows,
  buildSrtFromCues,
  cuesFromTiming,
  formatMotionClock,
  formatSrtTimestampMs,
  optimizeSrt,
  parseSrt,
  validateTimeline,
  type MotionBeat,
} from '@bokebox/shared';
import { renderMotionHtml } from '../src/services/motion/motionHtml.js';
import { validateMotionHtml } from '../src/services/motion/validateMotionHtml.js';
import { draftTimeline } from '../src/services/motion/index.js';
import type { Job } from '@bokebox/shared';

const SAMPLE_SRT = `1
00:00:00,000 --> 00:00:04,200
今天聊聊怎样把播客变成信息动画。

2
00:00:04,300 --> 00:00:09,800
首先，SRT 必须是唯一的时钟。

3
00:00:10,000 --> 00:00:15,600
其次，分镜绑定真实毫秒点。

4
00:00:15,700 --> 00:00:20,300
最后，收束页贴合主时钟总时长。`;

describe('motion srt parse & optimize', () => {
  it('parses srt into millisecond cues', () => {
    const cues = parseSrt(SAMPLE_SRT);
    assert.equal(cues.length, 4);
    assert.deepEqual(
      cues.map((c) => c.startMs),
      [0, 4300, 10000, 15700],
    );
    assert.equal(cues[3].endMs, 20300);
  });

  it('optimizes fragments, gaps and overlap', () => {
    const cues = parseSrt(SAMPLE_SRT);
    const out = optimizeSrt(cues);
    assert.ok(out.cues.length >= 4);
    assert.equal(out.stats.coverageMs, 20300);
    assert.equal(out.cues[0].startMs, 0);
    const last = out.cues[out.cues.length - 1];
    assert.equal(last.endMs, 20300);
  });

  it('repairs overlapping cues', () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:05,000
你好世界。

2
00:00:04,000 --> 00:00:08,000
这是一段重叠字幕。`);
    const out = optimizeSrt(cues);
    assert.equal(out.stats.repairedOverlap, 1);
    assert.ok(out.cues[0].endMs <= out.cues[1].startMs);
  });

  it('drops empty cues and reports gap stats', () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:03,000
第一句。

2
00:00:03,000 --> 00:00:04,000

3
00:00:05,000 --> 00:00:09,000
第二句。`);
    const out = optimizeSrt(cues, { dropEmpty: true });
    assert.equal(out.stats.dropped, 1);
    assert.equal(out.cues.length, 2);
    assert.ok(out.stats.gapMs >= 1000);
    assert.ok(out.stats.bigGapCount >= 1);
  });

  it('round-trips through buildSrtFromCues and format helpers', () => {
    const body = buildSrtFromCues([{ index: 1, startMs: 0, endMs: 1500, text: '测试' }]);
    assert.match(body, /00:00:00,000 --> 00:00:01,500/);
    assert.equal(formatSrtTimestampMs(65500), '00:01:05,500');
    assert.equal(formatMotionClock(75420), '01:15.420');
  });

  it('converts second-level timing to millisecond cues', () => {
    const cues = cuesFromTiming([
      { text: '第一句', startSec: 0.25, endSec: 3.5 },
      { text: '第二句', startSec: 3.5, endSec: 8.1 },
    ]);
    assert.deepEqual(
      cues.map((c) => [c.startMs, c.endMs]),
      [
        [250, 3500],
        [3500, 8100],
      ],
    );
  });
});

describe('motion timeline recovery', () => {
  it('uses embedded podcast timing when the legacy SRT file is missing', async () => {
    const job = {
      id: 'motion-inline-timing-recovery-test',
      title: '内嵌时间轴恢复',
      podcast: {
        title: '内嵌时间轴恢复',
        summary: '',
        tags: [],
        hostIntro: '',
        outline: [],
        script: '第一句。\n第二句。\n第三句。',
        showNotes: '',
        estimatedMinutes: 1,
        scriptTiming: [
          { text: '第一句', startSec: 0, endSec: 3 },
          { text: '第二句', startSec: 3, endSec: 6 },
          { text: '第三句', startSec: 6, endSec: 9 },
        ],
      },
    } as Job;

    const draft = await draftTimeline(job);
    assert.equal(draft.srtInfo?.source, 'script-timing');
    assert.equal(draft.durationMs, 9000);
    assert.equal(draft.error, undefined);
  });
});

describe('motion P3.5 timeline gate', () => {
  const beat = (id: string, startMs: number, endMs: number, stepTimes: number[] = []): MotionBeat => ({
    id,
    kind: 'motion',
    title: `章节 ${id}`,
    startMs,
    endMs,
    stepTimes,
    cueRange: [1, 2],
  });

  it('passes a fully covered timeline', () => {
    const beats = [
      beat('b1', 0, 12000, [5500, 9000]),
      { ...beat('b2', 12000, 24000), kind: 'closing' as const },
    ];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, true);
    assert.equal(gate.violations.length, 0);
    assert.equal(gate.rows.length, 2);
  });

  it('fills a large silence gap with a broll beat instead of failing', () => {
    const broll: MotionBeat = {
      id: 'b2',
      kind: 'broll',
      title: '过渡 · 下节预告',
      startMs: 12000,
      endMs: 18000,
      stepTimes: [],
      cueRange: [0, 0],
    };
    const beats = [
      beat('b1', 0, 12000, [5500]),
      broll,
      { ...beat('b3', 18000, 26000), kind: 'closing' as const },
    ];
    // 没有 broll 时，4s 空档必然违规
    const noBroll = validateTimeline([beats[0], beats[2]], 26000);
    assert.equal(noBroll.pass, false);
    assert.ok(noBroll.violations.some((v) => v.code === 'beat-gap'));
    // broll 填充后门禁通过
    const gate = validateTimeline(beats, 26000);
    assert.equal(gate.pass, true);
    assert.equal(gate.violations.length, 0);
    const brollRow = gate.rows.find((r) => r.kind === 'broll');
    assert.equal(brollRow?.startMs, 12000);
    assert.equal(brollRow?.endMs, 18000);
  });

  it('broll without steps does not trigger step violations', () => {
    const beats = [
      beat('b1', 0, 12000),
      { id: 'b2', kind: 'broll' as const, title: '间奏', startMs: 12000, endMs: 15000, stepTimes: [], cueRange: [0, 0] },
      { ...beat('b3', 15000, 24000), kind: 'closing' as const },
    ];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, true);
  });

  it('fails when first beat does not start at 0', () => {
    const beats = [beat('b1', 300, 12000)];
    const gate = validateTimeline(beats, 12000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'first-beat-not-zero'));
  });

  it('fails on beat overlap', () => {
    const beats = [beat('b1', 0, 12000), beat('b2', 11000, 24000)];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'beat-overlap'));
  });

  it('fails on gap over 1500ms', () => {
    const beats = [beat('b1', 0, 10000), beat('b2', 12500, 24000)];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'beat-gap'));
  });

  it('accepts narration-pace gaps within 1500ms', () => {
    const beats = [beat('b1', 0, 10000), { ...beat('b2', 10400, 24000), kind: 'closing' as const }];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, true);
    assert.equal(gate.gapMs, 400);
  });

  it('fails on step times out of range or non-monotonic', () => {
    const beats = [beat('b1', 0, 12000, [500, 12500]), beat('b2', 12000, 24000)];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'step-out-of-range'));
  });

  it('fails on non-monotonic step times', () => {
    const beats = [beat('b1', 0, 12000, [9000, 6000]), beat('b2', 12000, 24000)];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'step-not-monotonic'));
  });

  it('fails when closing beat does not reach duration', () => {
    const beats = [beat('b1', 0, 12000), { ...beat('b2', 12000, 20000), kind: 'closing' as const }];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'closing-not-at-end'));
  });

  it('requires the final beat to be a closing beat', () => {
    const gate = validateTimeline([beat('b1', 0, 24000)], 24000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'closing-kind'));
  });

  it('builds coverage rows with step anchors', () => {
    const beats = [beat('b1', 0, 12000, [5500]), { ...beat('b2', 12000, 24000), kind: 'closing' as const }];
    const rows = buildCoverageRows(beats);
    assert.equal(rows[0].stepTimes[0], 5500);
    assert.equal(rows[1].kind, 'closing');
  });
});

describe('motion AI page layer', () => {
  it('uses generated scene copy in the standalone HTML export', () => {
    const timeline = {
      version: 1 as const,
      jobId: 'job-motion-page',
      title: '页面测试',
      durationMs: 12000,
      source: 'srt' as const,
      srtCueCount: 2,
      optimizedCueCount: 2,
      beats: [
        {
          id: 'b1',
          kind: 'motion' as const,
          title: '旧标题',
          startMs: 0,
          endMs: 12000,
          stepTimes: [],
          cueRange: [1, 2] as [number, number],
        },
      ],
      page: {
        version: 1 as const,
        source: 'ai' as const,
        generatedAt: new Date().toISOString(),
        scenes: [{
          beatId: 'b1',
          layout: 'hero' as const,
          primitive: 'Claim' as const,
          visual: 'claim-lockup' as const,
          eyebrow: 'KEY IDEA',
          title: 'AI 页面标题',
          body: '根据口播稿生成的补充说明',
          bullets: ['第一条视觉要点'],
          accent: '#8b5cf6',
        }],
      },
    };
    const html = renderMotionHtml(timeline, 'job-motion-page');
    assert.match(html, /AI 页面标题/);
    assert.match(html, /根据口播稿生成的补充说明/);
    assert.match(html, /第一条视觉要点/);
    assert.equal(validateMotionHtml(html, timeline).ok, true);
  });

  it('renders independent compositions and replayable entrance motion per beat', () => {
    const timeline = {
      version: 1 as const,
      jobId: 'job-motion-variants',
      title: '构图测试',
      durationMs: 12000,
      source: 'srt' as const,
      srtCueCount: 3,
      optimizedCueCount: 3,
      beats: [
        { id: 'b1', kind: 'motion' as const, title: '先打爆点', startMs: 0, endMs: 4000, stepTimes: [2200], cueRange: [1, 1] as [number, number] },
        { id: 'b2', kind: 'motion' as const, title: '再给证据', startMs: 4000, endMs: 8000, stepTimes: [], cueRange: [2, 2] as [number, number] },
        { id: 'b3', kind: 'closing' as const, title: '最后锁帧', startMs: 8000, endMs: 12000, stepTimes: [], cueRange: [3, 3] as [number, number] },
      ],
      page: {
        version: 1 as const,
        source: 'ai' as const,
        generatedAt: new Date().toISOString(),
        style: 'apple-tech-gradient' as const,
        scenes: [
          { beatId: 'b1', layout: 'hero' as const, primitive: 'Claim' as const, visual: 'claim-lockup' as const, variant: 'hook-slam' as const, motion: 'slam' as const, eyebrow: 'HOOK', title: '先打爆点', body: '', bullets: [], accent: '#f97316', accent2: '#fbbf24' },
          { beatId: 'b2', layout: 'split' as const, primitive: 'Evidence' as const, visual: 'number-count' as const, variant: 'signal-bars' as const, motion: 'scan' as const, eyebrow: 'EVIDENCE', title: '再给证据', body: '', bullets: ['一个数字'], accent: '#22d3ee', accent2: '#a78bfa' },
          { beatId: 'b3', layout: 'closing' as const, primitive: 'Claim' as const, visual: 'quote-lock' as const, variant: 'closing-lock' as const, motion: 'slam' as const, eyebrow: 'CLOSE', title: '最后锁帧', body: '把结论留在画面里。', bullets: [], accent: '#fb7185', accent2: '#fbbf24' },
        ],
      },
    };
    const html = renderMotionHtml(timeline, 'job-motion-variants');
    assert.match(html, /beat-hook-slam/);
    assert.match(html, /beat-signal-bars/);
    assert.match(html, /beat-closing-lock/);
    assert.match(html, /motion-slam-in/);
    assert.match(html, /replayBeat/);
    assert.equal(validateMotionHtml(html, timeline).ok, true);
  });

  it('escapes generated kicker text in the standalone HTML export', () => {
    const timeline = {
      version: 1 as const,
      jobId: 'job-motion-escape',
      title: '页面测试',
      durationMs: 12000,
      source: 'srt' as const,
      srtCueCount: 1,
      optimizedCueCount: 1,
      beats: [{
        id: 'b1', kind: 'closing' as const, title: '标题', startMs: 0, endMs: 12000,
        stepTimes: [], cueRange: [1, 1] as [number, number],
      }],
      page: {
        version: 1 as const,
        source: 'ai' as const,
        generatedAt: new Date().toISOString(),
        scenes: [{
          beatId: 'b1', layout: 'closing' as const, primitive: 'Claim' as const,
          visual: 'quote-lock' as const, eyebrow: '<img src=x onerror=alert(1)>',
          title: '安全标题', body: '安全正文', bullets: [], accent: '#8b5cf6',
        }],
      },
    };
    const html = renderMotionHtml(timeline, 'job-motion-escape');
    assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});
