/**
 * Motion 模式 · S4 装配：由已确认时间轴生成自包含信息动画 HTML
 *
 * 参考 jacky-motion 的「SRT 唯一主时钟」运行时契约（MIT）：
 * - 主时钟 = performance.now() + requestAnimationFrame，禁止 setTimeout 链推进；
 * - 每 beat 绑定 data-start-ms / data-end-ms，多步再写 data-step-times；
 * - 收束页（closing）endMs 必须贴合主时钟总时长；
 * - Space 暂停/继续，←/→ 跳 5 秒，R 从头重播，F 全屏；
 * - 页面切后台返回后按绝对时钟追上正确画面，不补播错过的动画。
 *
 * 本生成器不引入 GSAP 等外部依赖：step 切换 = class 切换 + CSS transition/
 * keyframes，无网络依赖，离线可打开可录屏。
 */
import {
  formatMotionClock,
  type MotionTimeline,
} from '@bokebox/shared';
import { jobPaths } from '../../utils/paths.js';
import { confirmTimeline } from './timelineGate.js';
import fs from 'node:fs/promises';

/* ---- 文本转义 ---- */
function esc(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 封面渐变色（与 web 端 CoverArt 一致的一小撮），生成器只用它驱动 CSS 变量 */
function gradientPair(jobId: string): [string, string] {
  let seed = 0;
  for (const ch of String(jobId || '')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const palettes: Array<[string, string]> = [
    ['#6366f1', '#a855f7'],
    ['#0ea5e9', '#22d3ee'],
    ['#f43f5e', '#fb923c'],
    ['#10b981', '#84cc16'],
    ['#8b5cf6', '#ec4899'],
    ['#f59e0b', '#ef4444'],
  ];
  return palettes[seed % palettes.length];
}

/* ---- 运行时脚本（模板字符串内嵌） ---- */
function runtimeScript(): string {
  return String.raw`
(function () {
  'use strict';
  var stage = document.getElementById('stage');
  var beats = Array.prototype.slice.call(document.querySelectorAll('.beat'));
  var state = { beat: -1, step: 1 };

  /* 主时钟唯一时间表：全部来自已确认时间轴 */
  var schedule = beats.map(function (beat, index) {
    var stepTimes = beat.getAttribute('data-step-times');
    return {
      beat: beat,
      index: index,
      startMs: Number(beat.getAttribute('data-start-ms')),
      endMs: Number(beat.getAttribute('data-end-ms')),
      stepTimes: stepTimes
        ? stepTimes.split(',').map(function (v) { return Number(v.trim()); })
          .filter(function (n) { return Number.isFinite(n); })
        : []
    };
  });
  var AUTO_ENABLED = schedule.length > 0 && schedule.every(function (item) {
    return Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs;
  });
  var durationMs = AUTO_ENABLED ? schedule[schedule.length - 1].endMs : 0;

  var gate = document.getElementById('autoplayGate');
  var startButton = document.getElementById('autoplayStart');
  var countdownEl = document.getElementById('autoplayCount');
  var hudTime = document.getElementById('hudTime');
  var hudDots = document.getElementById('hudDots');

  var playback = {
    running: false,
    started: false,
    offsetMs: 0,
    startedAt: 0,
    frame: 0,
    countdownFrame: 0,
    countdownToken: 0
  };

  function clampTime(ms) { return Math.max(0, Math.min(ms, durationMs)); }
  function stepsOf(b) { return Math.max(1, Number(b.getAttribute('data-steps') || 1)); }

  function fmtClock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var mm = String(Math.floor(total / 60)).padStart(2, '0');
    var ss = String(total % 60).padStart(2, '0');
    var mmm = String(Math.max(0, Math.round(ms)) % 1000).padStart(3, '0');
    return mm + ':' + ss + '.' + mmm;
  }

  function updateHudTime(ms) {
    if (hudTime) hudTime.textContent = fmtClock(ms) + ' / ' + fmtClock(durationMs);
    var dotIndex = state.beat;
    if (hudDots) {
      Array.prototype.forEach.call(hudDots.children, function (dot, i) {
        dot.classList.toggle('cur', i === dotIndex);
      });
    }
  }

  function currentAutoplayTime() {
    return playback.running
      ? clampTime(playback.offsetMs + performance.now() - playback.startedAt)
      : clampTime(playback.offsetMs);
  }

  /* 静止帧：先落最终态，再决定是否播动画 */
  function settle(beat, step) {
    var target = step || 1;
    Array.prototype.forEach.call(beats, function (b, i) {
      b.classList.toggle('active', b === beat);
    });
    if (beat) {
      Array.prototype.forEach.call(beat.querySelectorAll('.step'), function (el, i) {
        el.classList.toggle('on', i < target);
        el.classList.toggle('settled', i < target);
      });
    }
    state.beat = beats.indexOf(beat);
    state.step = target;
    if (document.body) document.body.classList.remove('animating');
  }

  function animateStepIn(beat, step) {
    Array.prototype.forEach.call(beat.querySelectorAll('.step'), function (el, i) {
      el.classList.toggle('on', i < step);
      el.classList.toggle('settled', i < step - 1);
    });
    state.step = step;
    document.body.classList.add('animating');
  }

  function renderAt(ms, animate) {
    if (!AUTO_ENABLED) return;
    var t = clampTime(ms);
    var item = schedule[0];
    for (var i = 0; i < schedule.length; i++) {
      if (schedule[i].startMs <= t) item = schedule[i];
      else break;
    }
    var targetStep = Math.min(
      stepsOf(item.beat),
      1 + item.stepTimes.filter(function (stepMs) { return stepMs <= t; }).length
    );
    var sameBeat = state.beat === item.index;
    var lastFrame = t >= durationMs;

    if (!sameBeat) {
      if (animate && targetStep === 1) {
        settle(item.beat, 1);
        animateStepIn(item.beat, 1);
      } else {
        settle(item.beat, targetStep);
      }
    } else if (state.step !== targetStep) {
      if (animate && targetStep === state.step + 1) {
        animateStepIn(item.beat, targetStep);
      } else {
        settle(item.beat, targetStep);
      }
    }
    if (lastFrame) {
      settle(item.beat, stepsOf(item.beat));
      playback.running = false;
      document.body.classList.remove('autoplay-running');
    }
    updateHudTime(t);
  }

  function autoplayTick() {
    if (!playback.running) return;
    var t = currentAutoplayTime();
    renderAt(t, true);
    if (t >= durationMs) {
      playback.offsetMs = durationMs;
      return;
    }
    playback.frame = requestAnimationFrame(autoplayTick);
  }

  function startAutoplayClock() {
    if (!AUTO_ENABLED) return;
    if (playback.offsetMs >= durationMs) playback.offsetMs = 0;
    playback.started = true;
    playback.running = true;
    playback.startedAt = performance.now();
    if (gate) gate.hidden = true;
    document.body.classList.add('autoplay-running');
    cancelAnimationFrame(playback.frame);
    playback.frame = requestAnimationFrame(autoplayTick);
  }

  function pauseAutoplay() {
    if (!playback.running) return;
    playback.offsetMs = currentAutoplayTime();
    playback.running = false;
    cancelAnimationFrame(playback.frame);
    document.body.classList.remove('autoplay-running');
    renderAt(playback.offsetMs, false);
  }

  function toggleAutoplay() {
    if (!AUTO_ENABLED) return;
    if (!playback.started) { startCountdown(); return; }
    if (playback.running) pauseAutoplay();
    else startAutoplayClock();
  }

  function seekAutoplay(deltaMs) {
    if (!AUTO_ENABLED) return;
    var wasRunning = playback.running;
    if (wasRunning) playback.offsetMs = currentAutoplayTime();
    playback.offsetMs = clampTime(playback.offsetMs + deltaMs);
    playback.startedAt = performance.now();
    renderAt(playback.offsetMs, false);
  }

  function startCountdown() {
    if (!AUTO_ENABLED) return;
    pauseAutoplay();
    cancelAnimationFrame(playback.countdownFrame);
    var token = ++playback.countdownToken;
    playback.started = false;
    playback.offsetMs = 0;
    renderAt(0, false);
    if (gate) gate.hidden = false;
    if (countdownEl) countdownEl.hidden = false;
    if (startButton) startButton.hidden = true;
    var end = performance.now() + 3000;
    function tick(now) {
      if (token !== playback.countdownToken) return;
      var remaining = Math.max(0, end - now);
      if (countdownEl) countdownEl.textContent = String(Math.max(1, Math.ceil(remaining / 1000)));
      if (remaining <= 0) {
        if (countdownEl) countdownEl.hidden = true;
        if (startButton) startButton.hidden = false;
        startAutoplayClock();
        return;
      }
      playback.countdownFrame = requestAnimationFrame(tick);
    }
    playback.countdownFrame = requestAnimationFrame(tick);
  }

  function restartAutoplay() { startCountdown(); }

  if (startButton) {
    startButton.addEventListener('click', function () {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(function () {});
      }
      startCountdown();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); toggleAutoplay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekAutoplay(-5000); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekAutoplay(5000); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); restartAutoplay(); }
    else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && playback.running) renderAt(currentAutoplayTime(), false);
  });

  function scaleStage() {
    if (!stage) return;
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
  }
  window.addEventListener('resize', scaleStage);

  if (beats.length) {
    if (AUTO_ENABLED) {
      renderAt(0, false);
      scaleStage();
    }
  }
})();
`;
}

/* ---- beat 内容模板 ---- */
function beatHtml(input: {
  id: string;
  kind: string;
  title: string;
  stepLabels: string[];
  cueRange: [number, number];
  startMs: number;
  endMs: number;
  stepTimes: number[];
}): string {
  const steps = input.kind === 'broll'
    ? []
    : input.stepLabels.length
      ? input.stepLabels
      : [input.title];
  const stepNodes = steps
    .map((label, i) => {
      const isLast = i === steps.length - 1;
      return (
        `<div class="step${isLast ? ' step-lock' : ''}" data-step-label="${esc(label)}">` +
        `<span class="step-marker">${String(i + 1).padStart(2, '0')}</span>` +
        `<span class="step-text">${esc(label)}</span>` +
        `</div>`
      );
    })
    .join('');
  const isClosing = input.kind === 'closing';
  const isBroll = input.kind === 'broll';
  const kicker = isBroll
    ? 'B-ROLL'
    : isClosing
      ? '收束 · 总结'
      : `章节 ${input.cueRange[0]}–${input.cueRange[1]}`;
  const beatClass = `beat${isClosing ? ' beat-closing' : ''}${isBroll ? ' beat-broll' : ''}`;
  const brollIndex = isBroll
    ? `<div class="broll-index">${String(parseInt(input.id.replace(/\D+/gu, ''), 10) || 1).padStart(2, '0')}</div>`
    : '';
  return (
    `<section class="${beatClass}" id="${esc(input.id)}" ` +
    `data-kind="${esc(input.kind)}" data-steps="${steps.length}" ` +
    `data-start-ms="${input.startMs}" data-end-ms="${input.endMs}" ` +
    `data-step-times="${input.stepTimes.join(',')}">` +
    `<div class="scene">` +
    `${brollIndex}` +
    `<div class="beat-kicker">${kicker}</div>` +
    `<h2 class="beat-title">${esc(input.title)}</h2>` +
    `<div class="beat-steps">${stepNodes}</div>` +
    `</div></section>`
  );
}

/** 生成单文件 HTML（时间属性由已确认时间轴直接内联） */
export function renderMotionHtml(timeline: MotionTimeline, jobId: string): string {
  const [c1, c2] = gradientPair(jobId);
  const beatsHtml = timeline.beats
    .map((beat) =>
      beatHtml({
        id: beat.id,
        kind: beat.kind,
        title: beat.title,
        stepLabels:
          beat.stepLabels && beat.stepLabels.length
            ? beat.stepLabels
            : [beat.title],
        cueRange: beat.cueRange,
        startMs: beat.startMs,
        endMs: beat.endMs,
        stepTimes: beat.stepTimes,
      }),
    )
    .join('\n');

  const css = `
:root{
  --c1:${c1};--c2:${c2};
  --bg:#0b0d14;--text:#f4f5f7;--mute:rgba(244,245,247,.55);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{overflow:hidden;background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
#stage{width:1920px;height:1080px;position:fixed;left:50%;top:50%;
  overflow:hidden;background:
  radial-gradient(1200px 700px at 20% 0%, rgba(99,102,241,.16), transparent 60%),
  radial-gradient(1000px 600px at 85% 100%, rgba(168,85,247,.14), transparent 55%),
  var(--bg);
  transform:translate(-50%,-50%);transform-origin:center center}
.beat{position:absolute;inset:0;display:none}
.js .beat{display:none}
.js .beat.active{display:flex}
.scene{position:absolute;inset:0;display:flex;flex-direction:column;
  justify-content:center;padding:120px 160px}
.beat-kicker{font-size:26px;letter-spacing:.14em;color:var(--mute);
  text-transform:uppercase;margin-bottom:34px;
  display:flex;align-items:center;gap:18px}
.beat-kicker::before{content:"";width:52px;height:4px;border-radius:2px;
  background:linear-gradient(90deg,var(--c1),var(--c2))}
.beat-title{font-size:88px;line-height:1.22;font-weight:700;
  max-width:1500px;word-break:break-word;text-wrap:balance;margin-bottom:64px;
  text-shadow:0 2px 40px rgba(0,0,0,.35)}
.beat-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));
  gap:26px;max-width:1600px}
.step{display:flex;align-items:center;gap:20px;
  background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);
  border-radius:20px;padding:26px 30px;
  opacity:0;transform:translateY(22px);transition:none}
.js .step.on{opacity:1;transform:none;transition:opacity .5s cubic-bezier(.16,1,.3,1),transform .5s cubic-bezier(.16,1,.3,1)}
.step.settled{transition:none}
.step-marker{flex:none;font-size:24px;font-weight:700;letter-spacing:.06em;
  background:linear-gradient(120deg,var(--c1),var(--c2));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.step-text{font-size:32px;line-height:1.4;color:var(--text)}
.beat-closing .beat-title{font-size:76px;max-width:1400px}
.beat-closing .beat-steps{grid-template-columns:1fr}
.beat-closing .step{background:linear-gradient(90deg,rgba(99,102,241,.14),rgba(168,85,247,.1));
  border-color:rgba(139,92,246,.35)}
.beat-closing .step-lock .step-text{font-weight:600}
/* B-roll：无口播的静音过渡段（正式 beat，只显示序号与短标题） */
.beat-broll{background:radial-gradient(1000px 600px at 50% 40%,rgba(99,102,241,.12),transparent 60%)}
.beat-broll .scene{justify-content:center;align-items:center;text-align:center;gap:14px}
.beat-broll .beat-kicker{justify-content:center;letter-spacing:.5em;margin-bottom:10px}
.beat-broll .beat-kicker::before{display:none}
.beat-broll .beat-title{font-size:52px;max-width:1200px;margin-bottom:0}
.beat-broll .beat-steps{display:none}
.broll-index{font-size:220px;font-weight:700;line-height:1;letter-spacing:.08em;
  background:linear-gradient(120deg,var(--c1),var(--c2));
  -webkit-background-clip:text;background-clip:text;color:transparent;opacity:.4}
/* HUD */
.hud{position:absolute;left:0;right:0;bottom:0;height:56px;z-index:90;
  display:flex;align-items:center;justify-content:space-between;
  padding:0 36px;pointer-events:none;font-size:20px;color:var(--mute);
  font-variant-numeric:tabular-nums}
.hud-dots{display:flex;gap:10px}
.hud-dot{width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.18)}
.hud-dot.cur{background:linear-gradient(120deg,var(--c1),var(--c2))}
.autoplay-running .hud{opacity:0;transition:opacity .4s}
/* 准备层 */
.autoplay-gate{position:absolute;inset:0;z-index:120;display:grid;place-items:center;
  background:radial-gradient(900px 600px at 50% 30%,rgba(99,102,241,.14),transparent 65%),var(--bg)}
.autoplay-gate[hidden]{display:none}
.autoplay-panel{display:grid;justify-items:center;gap:30px;text-align:center}
.autoplay-kicker{font-size:24px;letter-spacing:.3em;color:var(--mute)}
.autoplay-title{font-size:84px;font-weight:700;max-width:1500px;
  background:linear-gradient(120deg,var(--c1),var(--c2));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.autoplay-start{min-width:340px;padding:22px 44px;border:none;border-radius:999px;
  background:linear-gradient(120deg,var(--c1),var(--c2));color:#fff;
  font-size:28px;font-weight:600;cursor:pointer}
.autoplay-controls{font-size:22px;line-height:1.6;color:var(--mute)}
.autoplay-count{font-size:220px;font-weight:700;line-height:1;
  background:linear-gradient(120deg,var(--c1),var(--c2));
  -webkit-background-clip:text;background-clip:text;color:transparent}
`;

  const durationMs = timeline.durationMs;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1920,initial-scale=1">
<title>${esc(timeline.title)} · Motion</title>
<style>${css}</style>
</head>
<body class="js">
<div id="stage">
${beatsHtml}
<div class="hud">
  <div class="hud-dots" id="hudDots">${timeline.beats.map(() => '<span class="hud-dot"></span>').join('')}</div>
  <span id="hudTime">00:00.000 / ${formatMotionClock(durationMs)}</span>
</div>
</div>
<div class="autoplay-gate" id="autoplayGate">
  <div class="autoplay-panel">
    <div class="autoplay-kicker">MOTION · ${esc(timeline.title)}</div>
    <h1 class="autoplay-title">${esc(timeline.title)}</h1>
    <button class="autoplay-start" id="autoplayStart">准备播放</button>
    <div class="autoplay-controls">空格 暂停/继续 · ←/→ 跳 5 秒 · R 重播 · F 全屏</div>
    <div class="autoplay-count" id="autoplayCount" hidden>3</div>
  </div>
</div>
<script>
${runtimeScript()}
</script>
</body>
</html>
`;
}

/** 装配：确认时间轴（门禁）→ 生成 HTML → 落盘 motion.html */
export async function buildMotionHtmlFile(
  jobId: string,
  timeline: MotionTimeline,
): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }> {
  const confirmed = await confirmTimeline(jobId, timeline);
  if (!confirmed.ok) {
    const codes = confirmed.gate.violations.map((v) => v.code).join(', ');
    return { ok: false, error: `时间轴未通过确认门：${codes}` };
  }
  const html = renderMotionHtml(timeline, jobId);
  const file = jobPaths(jobId).motionHtml;
  await fs.writeFile(file, html, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');
  return { ok: true, file, bytes };
}
