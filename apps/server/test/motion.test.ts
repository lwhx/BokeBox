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

  it('fails on gap over 500ms', () => {
    const beats = [beat('b1', 0, 10000), beat('b2', 12000, 24000)];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, false);
    assert.ok(gate.violations.some((v) => v.code === 'beat-gap'));
  });

  it('accepts gaps within 500ms', () => {
    const beats = [beat('b1', 0, 10000), beat('b2', 10400, 24000)];
    const gate = validateTimeline(beats, 24000);
    assert.equal(gate.pass, true);
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

  it('builds coverage rows with step anchors', () => {
    const beats = [beat('b1', 0, 12000, [5500]), { ...beat('b2', 12000, 24000), kind: 'closing' as const }];
    const rows = buildCoverageRows(beats);
    assert.equal(rows[0].stepTimes[0], 5500);
    assert.equal(rows[1].kind, 'closing');
  });
});
