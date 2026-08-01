import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateTimeline, type SrtCue } from '@bokebox/shared';
import { buildStoryboard } from '../src/services/motion/storyboard.js';

function cue(startMs: number, endMs: number, text: string): SrtCue {
  return { index: 0, startMs, endMs, text };
}

describe('motion storyboard (server)', () => {
  it('derives more animation beats from a longer spoken chapter', () => {
    const cues = Array.from({ length: 24 }, (_, index) =>
      cue(index * 3000, index * 3000 + 2600, `第${index + 1}段继续解释这个方法如何落地并带来实际变化，同时补充一个可以执行的具体步骤。`),
    );
    const chapters = [{
      id: 'long-script',
      title: '完整方法',
      summary: '长口播稿应按内容长度拆成更多动画区间。',
      script: cues.map((item) => item.text).join('\n'),
    }];
    const story = buildStoryboard({ title: '长稿', cues, chapters });

    assert.ok(story.beats.length > 3, '长口播稿不应仍被限制在 2–3 个页面');
    assert.equal(story.beats.at(-1)?.kind, 'closing');
    assert.equal(story.beats[0].startMs, 0);
    const gate = validateTimeline(story.beats, cues.at(-1)!.endMs);
    assert.equal(gate.pass, true);
  });

  it('uses upstream motion chapters and preserves their semantic order', () => {
    const cues: SrtCue[] = [
      cue(0, 4000, '先说结论，这个方法会改变内容生产。'),
      cue(4500, 9000, '第一章继续解释为什么要改变节奏。'),
      cue(18000, 23000, '第二章只保留真正有用的观点。'),
      cue(23500, 29000, '最后把方法变成可以重复的行动。'),
    ];
    const chapters = [
      { id: 'hook', title: '先说结论', summary: '先给听众一个明确方向。', script: '先说结论，这个方法会改变内容生产。' },
      { id: 'core', title: '保留重点', summary: '只保留真正有用的观点。', script: '第二章只保留真正有用的观点。' },
      { id: 'close', title: '变成行动', summary: '把方法变成可重复的行动。', script: '最后把方法变成可以重复的行动。' },
    ];
    const story = buildStoryboard({ title: '测试', cues, chapters });
    assert.equal(story.beats.length, 3);
    assert.deepEqual(story.beats.map((b) => b.kind), ['motion', 'motion', 'closing']);
    assert.deepEqual(story.beats.map((b) => b.chapterId), ['hook', 'core', 'close']);
    assert.equal(story.beats.some((b) => b.kind === 'broll'), false);
    const gate = validateTimeline(story.beats, cues[cues.length - 1].endMs);
    assert.equal(gate.pass, true);
  });

  it('first beat always starts at 0ms even when the outline anchor lands mid-narration', () => {
    const cues: SrtCue[] = [
      cue(0, 4200, '大家好，欢迎收听不上班实验室，我是兰。'),
      cue(4600, 8900, '今天咱们聊个有点意思的话题，关于博士就业。'),
      cue(9300, 15000, '你可能听过这种说法，博士毕业除了去高校就失业。'),
      cue(15400, 21500, '但现实是，大部分 STEM 博士毕业后其实是去了企业。'),
      cue(21900, 28900, '可问题是，培养模式还是奔着当教授去设计的。'),
      cue(29300, 36500, '美国国家科学基金会最近干了件大事，宣布要砸四千万美元。'),
      cue(36900, 44000, '这个试点项目联合了三十多所大学和一堆企业。'),
      cue(44400, 51200, '今天的分享就到这里，感谢收听，我们下期再见。'),
    ];
    // 首段标题刻意与中段 cue 高度重叠，迫使锚点前移失败（旧版首段会从 ~9s 开始）
    const outline = [
      { title: '博士就业的现实与错位', summary: '破除博士毕业即失业的刻板印象，大多数 STEM 博士毕业后去了企业。' },
      { title: 'NSF 的试点计划', summary: '美国国家科学基金会宣布砸四千万美元，联合大学与企业改革培养模式。' },
      { title: '总结收束', summary: '今天的分享就到这里，感谢收听。' },
    ];
    const story = buildStoryboard({ title: '测试', cues, outline });
    assert.ok(story.beats.length >= 2, 'outline 应产出至少 2 个 beat');
    assert.equal(story.beats[0].startMs, 0, '首 beat 必须从 0ms 开始');
    const gate = validateTimeline(story.beats, cues[cues.length - 1].endMs);
    assert.equal(gate.pass, true);
    assert.deepEqual(gate.violations, []);
  });

  it('keeps large silences inside compact chapter windows', () => {
    const cues: SrtCue[] = [
      cue(0, 4000, '第一段开场口播，介绍今天的话题。'),
      cue(4600, 9000, '这一段讲背景信息，补充一些细节。'),
      // 600ms 句间停顿：正常口播节奏，不应生成 broll
      cue(9600, 13000, '这里有个六百毫秒的句间停顿。'),
      // 8s 静音（音乐/停顿）
      cue(21000, 25000, '中间插播一段广告，我们马上回来。'),
      cue(25500, 30000, '今天的分享就到这里，感谢收听。'),
    ];
    const outline = [{ title: '完整段落', summary: '含长静音的段落' }];
    const story = buildStoryboard({ title: '测试', cues, outline });
    assert.ok(story.beats.length <= 3, '页面数量应保持在 3 张以内');
    assert.equal(story.beats.some((b) => b.kind === 'broll'), false);
    assert.equal(story.beats[0].startMs, 0);
    const gate = validateTimeline(story.beats, cues[cues.length - 1].endMs);
    assert.equal(gate.pass, true);
  });
});
