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
 * keyframes。独立页面由 BokeBox 服务时，通过同源媒体路由加载当前任务音频。
 */
import {
  formatMotionClock,
  type MotionScene,
  type MotionSceneMotion,
  type MotionSceneVariant,
  type MotionTimeline,
} from '@bokebox/shared';
import { jobPaths } from '../../utils/paths.js';
import { confirmTimeline } from './timelineGate.js';
import { validateMotionHtml } from './validateMotionHtml.js';
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
  var audio = document.getElementById('motionAudio');
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
  var audioStatus = document.getElementById('autoplayAudioStatus');
  var audioUnlock = document.getElementById('audioUnlock');
  var canvasKicker = document.getElementById('motionCanvasKicker');
  var canvasClock = document.getElementById('motionCanvasClock');
  var motionCanvas = document.querySelector('.qq-motion-canvas');

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

  function updateCanvasChrome(item, ms) {
    if (!item || !item.beat) return;
    if (motionCanvas) {
      motionCanvas.style.setProperty('--motion-accent', item.beat.getAttribute('data-accent') || '#e85d36');
      motionCanvas.style.setProperty('--motion-accent-2', item.beat.getAttribute('data-accent-2') || '#fbbf24');
    }
    if (canvasKicker) canvasKicker.textContent = item.beat.getAttribute('data-eyebrow') || 'MOTION';
    if (canvasClock) canvasClock.textContent = fmtClock(ms) + ' / ' + fmtClock(durationMs);
  }

  function updateGraphicProgress(beat, step) {
    if (!beat) return;
    Array.prototype.forEach.call(beat.querySelectorAll('[data-step-index]'), function (el) {
      var index = Number(el.getAttribute('data-step-index')) || 0;
      var visible = index < step;
      el.classList.toggle('is-visible', visible);
      el.style.display = visible ? '' : 'none';
    });
    var number = beat.querySelector('[data-step-number]');
    if (number) number.textContent = String(Math.min(step, stepsOf(beat))).padStart(2, '0');
    var splitAfter = beat.querySelector('[data-split-after]');
    if (splitAfter) {
      splitAfter.textContent = step > 1
        ? (splitAfter.getAttribute('data-split-after') || beat.getAttribute('data-scene-title') || '')
        : (beat.getAttribute('data-scene-title') || '');
    }
  }

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

  function audioSource() {
    var path = window.location.pathname || '';
    var source = path.replace(/\/motion\.html$/, '/audio');
    if (source === path) {
      var jobId = document.body && document.body.getAttribute('data-motion-job');
      source = '/api/jobs/' + encodeURIComponent(jobId || '') + '/audio';
    }
    try {
      var params = new URLSearchParams(window.location.search || '');
      var token = params.get('access_token') || params.get('token');
      if (token) source += (source.indexOf('?') >= 0 ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
    } catch (e) {
      /* 旧浏览器没有 URLSearchParams 时，cookie 鉴权仍可工作。 */
    }
    return source;
  }

  function seekAudio(ms) {
    if (!audio) return;
    try {
      audio.currentTime = clampTime(ms) / 1000;
    } catch (e) {
      /* 音频 metadata 尚未就绪时，下一次播放会再次校准。 */
    }
  }

  function ensureAudioSource() {
    if (!audio) return false;
    if (!audio.getAttribute('src')) audio.setAttribute('src', audioSource());
    return Boolean(audio.getAttribute('src'));
  }

  function showAudioStatus(message) {
    if (!audioStatus) return;
    audioStatus.textContent = message;
    audioStatus.hidden = false;
  }

  function clearAudioStatus() {
    if (audioStatus) audioStatus.hidden = true;
  }

  function setAudioUnlockVisible(visible) {
    if (audioUnlock) audioUnlock.hidden = !visible;
  }

  function primeAudio() {
    if (!ensureAudioSource()) return;
    audio.muted = false;
    seekAudio(0);
    var promise = audio.play();
    if (promise && promise.then) {
      promise.then(function () {
        clearAudioStatus();
        setAudioUnlockVisible(false);
        /* 先在用户手势内取得播放权限，倒计时期间不消耗正片音频。 */
        if (!playback.running) {
          audio.pause();
          seekAudio(0);
        }
      }).catch(function () {
        showAudioStatus('点击“播放并启用声音”后，浏览器才会输出音频');
      });
    }
  }

  function startAudio(ms) {
    if (!ensureAudioSource()) return;
    audio.muted = false;
    seekAudio(ms);
    var promise = audio.play();
    if (promise && promise.then) {
      promise.then(function () {
        clearAudioStatus();
        setAudioUnlockVisible(false);
      }).catch(function () {
        showAudioStatus('音频播放被浏览器拦截，请再次点击播放按钮');
        setAudioUnlockVisible(true);
      });
    }
  }

  function pauseAudio(reset) {
    if (!audio) return;
    audio.pause();
    audio.muted = false;
    if (reset) seekAudio(0);
  }

  function tryAutoplay() {
    if (!AUTO_ENABLED || !ensureAudioSource()) return;
    audio.muted = false;
    seekAudio(0);
    var promise = audio.play();
    if (promise && promise.then) {
      promise.then(function () {
        clearAudioStatus();
        startAutoplayClock();
      }).catch(function () {
        /* 浏览器阻止有声自动播放时，先让画面自动预览。 */
        startAutoplayClock();
        if (audioUnlock) audioUnlock.textContent = '点击启用声音';
        setAudioUnlockVisible(true);
      });
    } else {
      startAutoplayClock();
    }
  }

  /* 静止帧：先落最终态，再决定是否播动画 */
  function settle(beat, step) {
    var target = step || 1;
    Array.prototype.forEach.call(beats, function (b, i) {
      b.classList.toggle('active', b === beat);
      b.classList.remove('is-entering');
    });
    if (beat) {
      Array.prototype.forEach.call(beat.querySelectorAll('.step'), function (el, i) {
        el.classList.toggle('on', i < target);
        el.classList.toggle('settled', i < target);
      });
      updateGraphicProgress(beat, target);
    }
    state.beat = beats.indexOf(beat);
    state.step = target;
    if (document.body) document.body.classList.remove('animating');
  }

  /* 同一文件内每个 beat 都有自己的入场编排，重播时强制重置 CSS 动画。 */
  function replayBeat(beat) {
    if (!beat) return;
    beat.classList.remove('is-entering');
    void beat.offsetWidth;
    beat.classList.add('is-entering');
  }

  function animateStepIn(beat, step) {
    Array.prototype.forEach.call(beat.querySelectorAll('.step'), function (el, i) {
      el.classList.toggle('on', i < step);
      el.classList.toggle('settled', i < step - 1);
    });
    state.step = step;
    updateGraphicProgress(beat, step);
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
        replayBeat(item.beat);
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
      pauseAudio(false);
      document.body.classList.remove('autoplay-running');
    }
    updateCanvasChrome(item, t);
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
    var firstRun = !playback.started;
    playback.started = true;
    playback.running = true;
    playback.startedAt = performance.now();
    if (gate) gate.hidden = true;
    document.body.classList.add('autoplay-running');
    startAudio(playback.offsetMs);
    if (firstRun) {
      var startItem = schedule[0];
      for (var i = 0; i < schedule.length; i++) {
        if (schedule[i].startMs <= playback.offsetMs) startItem = schedule[i];
        else break;
      }
      replayBeat(startItem.beat);
    }
    cancelAnimationFrame(playback.frame);
    playback.frame = requestAnimationFrame(autoplayTick);
  }

  function pauseAutoplay() {
    if (!playback.running) return;
    playback.offsetMs = currentAutoplayTime();
    playback.running = false;
    cancelAnimationFrame(playback.frame);
    pauseAudio(false);
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
    if (wasRunning) startAudio(playback.offsetMs);
    renderAt(playback.offsetMs, false);
  }

  function startCountdown() {
    if (!AUTO_ENABLED) return;
    pauseAutoplay();
    cancelAnimationFrame(playback.countdownFrame);
    var token = ++playback.countdownToken;
    playback.started = false;
    playback.offsetMs = 0;
    pauseAudio(true);
    primeAudio();
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
  if (audio) {
    audio.addEventListener('error', function () {
      showAudioStatus('当前任务没有可播放的播客音频');
      if (audioUnlock) audioUnlock.textContent = '音频不可用';
      setAudioUnlockVisible(true);
    });
  }
  if (audioUnlock) {
    audioUnlock.addEventListener('click', function () {
      if (!playback.running) startAutoplayClock();
      else startAudio(currentAutoplayTime());
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
      ensureAudioSource();
      tryAutoplay();
    }
  }
})();
`;
}

/* ---- beat 内容模板 ---- */
const SCENE_VARIANTS: MotionSceneVariant[] = [
  'hook-slam',
  'diagonal-reveal',
  'signal-bars',
  'before-after',
  'stack-cascade',
  'quote-cut',
  'ticker-drive',
  'closing-lock',
];
const SCENE_MOTIONS: MotionSceneMotion[] = [
  'slam',
  'wipe',
  'scan',
  'cascade',
  'drift',
  'type-on',
  'pulse',
];

function safeHex(value: unknown, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(String(value || ''))
    ? String(value)
    : fallback;
}

function deriveVariant(
  scene: MotionScene | undefined,
  kind: string,
  index: number,
): MotionSceneVariant {
  if (scene?.variant && SCENE_VARIANTS.includes(scene.variant)) return scene.variant;
  if (kind === 'closing') return 'closing-lock';
  if (kind === 'broll') return 'diagonal-reveal';
  if (index === 0) return 'hook-slam';
  if (scene?.visual === 'number-count') return 'signal-bars';
  if (scene?.visual === 'split-compare') return 'before-after';
  if (scene?.visual === 'path-build') return 'stack-cascade';
  if (scene?.visual === 'quote-lock') return 'quote-cut';
  return SCENE_VARIANTS[(index - 1) % (SCENE_VARIANTS.length - 1)];
}

function deriveMotion(
  scene: MotionScene | undefined,
  variant: MotionSceneVariant,
  index: number,
): MotionSceneMotion {
  if (scene?.motion && SCENE_MOTIONS.includes(scene.motion)) return scene.motion;
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
  return byVariant[variant] || SCENE_MOTIONS[index % SCENE_MOTIONS.length];
}

function uniqueMotionLabels(values: string[], title: string): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => String(value || '').replace(/\s+/gu, ' ').trim())
    .filter((value) => {
      if (!value || value === title || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, 4);
}
function beatHtml(input: {
  id: string;
  kind: string;
  title: string;
  stepLabels: string[];
  cueRange: [number, number];
  startMs: number;
  endMs: number;
  stepTimes: number[];
  scene?: MotionScene;
  index: number;
}): string {
  const sceneTitle = input.scene?.title || input.title;
  const bullets = input.kind === 'broll'
    ? []
    : uniqueMotionLabels(
      input.scene?.bullets?.length ? input.scene.bullets : input.stepLabels,
      sceneTitle,
    );
  const isClosing = input.kind === 'closing';
  const isBroll = input.kind === 'broll';
  const variant = deriveVariant(input.scene, input.kind, input.index);
  const motion = deriveMotion(input.scene, variant, input.index);
  const layout = input.scene?.layout || (isClosing ? 'closing' : isBroll ? 'quote' : input.index === 0 ? 'hero' : 'split');
  const visual = input.scene?.visual || (isClosing ? 'quote-lock' : bullets.length > 1 ? 'path-build' : 'claim-lockup');
  const primitive = input.scene?.primitive || (bullets.length > 1 ? 'Path' : 'Claim');
  const kicker = input.scene?.eyebrow || (isBroll
    ? 'B-ROLL'
    : isClosing
      ? '收束 · 总结'
      : `章节 ${input.cueRange[0]}–${input.cueRange[1]}`);
  const sceneAccent = safeHex(input.scene?.accent, '#e85d36');
  const sceneAccent2 = safeHex(input.scene?.accent2, '#fbbf24');
  const beatClass = [
    'beat',
    'beat-' + variant,
    'motion-' + motion,
    isClosing ? 'beat-closing' : '',
    isBroll ? 'beat-broll' : '',
  ].filter(Boolean).join(' ');
  const graphic = visual === 'number-count'
    ? `<div class="qq-motion-live-number"><strong data-step-number>${String(Math.max(1, bullets.length ? 1 : 1)).padStart(2, '0')}</strong><span>KEY POINTS</span></div>`
    : visual === 'quote-lock'
      ? `<blockquote class="qq-motion-live-quote">${esc(input.scene?.body || sceneTitle)}</blockquote>`
      : visual === 'split-compare'
        ? `<div class="qq-motion-live-split"><div><small>BEFORE</small><strong>${esc(bullets[0] || '原来的做法')}</strong></div><i></i><div class="is-focus"><small>AFTER</small><strong data-split-after="${esc(bullets[1] || sceneTitle)}">${esc(sceneTitle)}</strong></div></div>`
        : visual === 'system-layer-expand'
          ? `<div class="qq-motion-live-layers">${bullets.slice(0, 3).map((label, i) => `<div data-step-index="${i}"><span>${String(i + 1).padStart(2, '0')}</span><strong>${esc(label)}</strong></div>`).join('')}</div>`
          : visual === 'path-build'
            ? `<div class="qq-motion-live-path">${bullets.map((label, i) => `<div class="qq-motion-live-path-item" data-step-index="${i}"><span>${String(i + 1).padStart(2, '0')}</span><strong>${esc(label)}</strong>${i < bullets.length - 1 ? '<i aria-hidden="true"></i>' : ''}</div>`).join('')}</div>`
            : `<div class="qq-motion-live-lockup"><i aria-hidden="true"></i><span>${esc(primitive)}</span></div>`;
  return (
    `<section class="${beatClass}" id="${esc(input.id)}" ` +
    `data-kind="${esc(input.kind)}" data-steps="${bullets.length}" data-eyebrow="${esc(kicker)}" ` +
    `data-scene-title="${esc(sceneTitle)}" data-primitive="${esc(primitive)}" data-visual-demo="${esc(visual)}" ` +
    `data-accent="${sceneAccent}" data-accent-2="${sceneAccent2}" ` +
    `data-variant="${variant}" data-motion="${motion}" data-start-ms="${input.startMs}" data-end-ms="${input.endMs}" ` +
    `style="--scene-accent:${sceneAccent};--scene-accent-2:${sceneAccent2};--scene-order:${input.index}" data-step-times="${input.stepTimes.join(',')}">` +
    `<div class="qq-motion-scene is-${esc(layout)} is-${esc(visual)} is-variant-${variant} is-motion-${motion}">` +
    `<div class="qq-motion-scene-index">${String(input.index + 1).padStart(2, '0')}</div>` +
    `<div class="qq-motion-scene-copy"><h4>${esc(sceneTitle)}</h4>` +
    (input.scene?.body ? `<p>${esc(input.scene.body)}</p>` : '') +
    `${graphic}</div></div></section>`
  );
}

/** Jacky-motion 风格的页面层：风格 token + 信息原语 + 舒展构图。 */
function richMotionCss(): string {
  return String.raw`
body{background:#000}
body.style-editorial-magazine #stage,body.style-newspaper-evidence #stage,body.style-paper-collage #stage{--ink:#171717;--mute:#6b665e;--rule:rgba(23,23,23,.2);--accent:#b91c1c;background:#f1ede5;color:var(--ink)}
body.style-sketch-note #stage{--ink:#28231e;--mute:#777067;--rule:rgba(40,35,30,.28);--accent:#d92d20;background-color:#f5f1e8;background-image:linear-gradient(rgba(71,115,143,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(71,115,143,.09) 1px,transparent 1px);background-size:34px 34px;color:var(--ink)}
body.style-finance-studio-cards #stage{--ink:#ecfeff;--mute:rgba(236,254,255,.58);--rule:rgba(45,212,191,.28);--accent:#2dd4bf;background:linear-gradient(135deg,#091b1e,#061012 76%);color:var(--ink)}
body.style-paper-collage #stage{--ink:#211d1a;--mute:#6d6259;--rule:rgba(33,29,26,.2);--accent:#e85d36;background:#f3ead9;color:var(--ink)}
body.style-editorial-magazine #stage::before,body.style-newspaper-evidence #stage::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 13%,rgba(23,23,23,.035) 13.05% 13.1%);pointer-events:none}
body.style-sketch-note #stage::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 20% 30%,rgba(217,45,32,.05),transparent 22%);pointer-events:none}
.scene{justify-content:center;padding:116px 150px 150px;z-index:1}
.beat-kicker{position:relative;z-index:2;margin-bottom:30px;color:var(--accent,var(--c1));font:700 22px/1.2 var(--font-mono,ui-monospace);letter-spacing:.12em}
.beat-kicker::before{background:var(--accent,var(--c1));width:44px;height:2px}
.beat-title{position:relative;z-index:2;margin-bottom:26px;max-width:1250px;color:var(--ink,var(--text));font-size:112px;line-height:1.1;letter-spacing:0;font-weight:650;word-break:keep-all;text-wrap:balance}
.beat-body{position:relative;z-index:2;margin:0 0 34px;max-width:820px;color:var(--mute,var(--text));font-size:28px;line-height:1.5}
.scene-visual{position:relative;z-index:2;max-width:1180px;margin-top:4px}
.beat-steps{position:relative;z-index:2;max-width:1180px;margin-top:38px;display:grid;gap:18px}
.beat-steps.visual-path-build{grid-template-columns:repeat(4,minmax(0,1fr));gap:0;align-items:start}
.beat-steps.visual-path-build .step{position:relative;border:0;border-top:2px solid var(--accent,var(--c1));border-radius:0;background:transparent;padding:16px 24px 0 0;opacity:0;transform:translateY(18px)}
.js .beat-steps.visual-path-build .step.on{opacity:1;transform:none;transition:opacity .65s cubic-bezier(.16,1,.3,1),transform .65s cubic-bezier(.16,1,.3,1)}
.beat-steps.visual-path-build .step::after{content:"";position:absolute;top:-7px;left:0;width:11px;height:11px;border-radius:50%;background:var(--accent,var(--c1));box-shadow:0 0 0 5px color-mix(in srgb,var(--accent,var(--c1)) 18%,transparent)}
.beat-steps.visual-path-build .step-marker{display:block;margin-bottom:10px;color:var(--accent,var(--c1));font-size:18px}
.beat-steps.visual-path-build .step-text{color:var(--ink,var(--text));font-size:26px;line-height:1.35}
.beat-steps:not(.visual-path-build){display:none}
.scene-lockup{display:flex;align-items:center;gap:15px;color:var(--accent,var(--c1));font:700 18px var(--font-mono,ui-monospace);letter-spacing:.12em}
.scene-lockup i{display:block;width:72px;height:2px;background:var(--accent,var(--c1))}
.scene-quote{max-width:980px;margin:20px 0 0;padding-left:28px;border-left:5px solid var(--accent,var(--c1));color:var(--ink,var(--text));font:650 54px/1.28 Georgia,'Songti SC',serif}
.scene-number{display:flex;align-items:baseline;gap:20px;margin:8px 0 0;color:var(--accent,var(--c1))}
.scene-number strong{font:650 260px/.9 var(--font-mono,ui-monospace);letter-spacing:-.06em}
.scene-number span{font:700 20px var(--font-mono,ui-monospace);letter-spacing:.12em;color:var(--mute,var(--text))}
.scene-split{display:grid;grid-template-columns:1fr 54px 1fr;max-width:1050px;align-items:stretch;border-top:2px solid var(--rule,rgba(255,255,255,.15));border-bottom:2px solid var(--rule,rgba(255,255,255,.15))}
.scene-split>div{display:grid;gap:18px;align-content:center;min-height:170px;padding:28px 34px}
.scene-split>div.is-focus{background:color-mix(in srgb,var(--accent,var(--c1)) 10%,transparent)}
.scene-split>div small{color:var(--mute,var(--text));font:700 17px var(--font-mono,ui-monospace);letter-spacing:.12em}
.scene-split>div strong{color:var(--ink,var(--text));font-size:32px;line-height:1.3}
.scene-split>i{width:2px;height:64%;align-self:center;background:var(--rule,rgba(255,255,255,.15))}
.scene-layers{display:grid;gap:12px;max-width:950px}
.scene-layers .layer{display:grid;grid-template-columns:70px 1fr;gap:22px;align-items:center;padding:18px 22px;border-left:5px solid var(--accent,var(--c1));border-bottom:1px solid var(--rule,rgba(255,255,255,.15));background:color-mix(in srgb,var(--accent,var(--c1)) 6%,transparent)}
.scene-layers .layer span{color:var(--accent,var(--c1));font:700 18px var(--font-mono,ui-monospace)}
.scene-layers .layer strong{color:var(--ink,var(--text));font-size:31px}
body.style-editorial-magazine .beat-title,body.style-newspaper-evidence .beat-title{font-family:Georgia,'Songti SC','STSong',serif;font-weight:850}
body.style-editorial-magazine .beat-title{font-size:124px}
body.style-sketch-note .beat-title{font-family:'STKaiti','KaiTi',serif;font-weight:700}
body.style-paper-collage .beat-title{transform:rotate(-1deg);font-weight:850}
body.style-paper-collage #stage::before{content:"";position:absolute;inset:110px 150px 150px 760px;transform:rotate(3deg);background:#fbf4e7;box-shadow:18px 20px 0 rgba(33,29,26,.12);pointer-events:none}
body.style-sketch-note .scene-split,body.style-sketch-note .scene-layers{border-style:dashed}
body.style-sketch-note .scene-split>div,body.style-sketch-note .scene-layers .layer{border-style:dashed}
body.style-finance-studio-cards .scene-number strong{font-size:320px}
body.style-finance-studio-cards .scene-layers .layer{background:rgba(45,212,191,.06);border-color:var(--accent)}
.beat-closing .scene{align-items:center;text-align:center}
.beat-closing .beat-title{max-width:1320px}
.beat-closing .scene-quote{margin-left:auto;margin-right:auto;text-align:left}
.beat-broll .scene{padding:90px 130px}
@media (max-width:900px){.scene{padding:100px 90px}.beat-title{font-size:76px}.scene-number strong{font-size:170px}.scene-quote{font-size:38px}.scene-split>div strong{font-size:24px}}
`;
}

/** 录屏向动效覆盖层：每个 scene 通过 variant + motion 组合出独立构图。 */
function kineticMotionCss(): string {
  return String.raw`
/* wide composition */
.scene{padding:104px 132px 82px;overflow:hidden}
.scene-meta,.scene-footer{position:relative;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:24px}
.scene-meta{margin-bottom:38px}
.scene-counter{color:var(--motion-muted,var(--mute));font:700 16px/1.2 var(--font-mono,ui-monospace);letter-spacing:.12em;text-transform:uppercase}
.scene-copy{position:relative;z-index:3;max-width:1480px}
.beat-title{max-width:1480px;margin:0;color:var(--motion-ink,var(--ink,var(--text)));font-size:110px;line-height:1.05;letter-spacing:-.045em;text-wrap:balance;word-break:keep-all}
.beat-body{max-width:820px;margin:26px 0 0;color:var(--motion-muted,var(--mute));font-size:28px;line-height:1.45}
.scene-visual{position:relative;z-index:3;margin-top:42px;max-width:1280px}
.beat-steps,.beat-steps:not(.visual-path-build){position:relative;z-index:3;display:grid;gap:10px;max-width:900px;margin-top:28px}
.beat-steps:empty{display:none}
.scene-footer{margin-top:auto;padding-top:16px;border-top:1px solid var(--motion-rule,var(--rule));color:var(--motion-muted,var(--mute));font:700 14px/1.2 var(--font-mono,ui-monospace);letter-spacing:.12em;text-transform:uppercase}
.scene-backdrop{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.backdrop-glow{position:absolute;width:820px;height:820px;right:-190px;top:-280px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--scene-accent) 25%,transparent),transparent 68%);filter:blur(8px);opacity:.72}
.backdrop-line{position:absolute;width:1350px;height:2px;right:-210px;top:64%;transform:rotate(-18deg);transform-origin:right center;background:linear-gradient(90deg,transparent,var(--scene-accent),var(--scene-accent-2),transparent);opacity:.45}
.backdrop-grid{position:absolute;inset:0;opacity:.2;background-image:linear-gradient(var(--motion-rule,var(--rule)) 1px,transparent 1px),linear-gradient(90deg,var(--motion-rule,var(--rule)) 1px,transparent 1px);background-size:96px 96px;mask-image:linear-gradient(135deg,#000,transparent 72%)}
.step{min-height:54px;display:flex;align-items:center;gap:16px;opacity:0;transform:translateY(18px);will-change:transform,opacity}
.step.on{opacity:1;transform:none;transition:opacity .44s cubic-bezier(.16,1,.3,1),transform .58s cubic-bezier(.16,1,.3,1)}
.step.settled{transition:none}
.step-marker{flex:none;color:var(--scene-accent);font:800 16px/1 var(--font-mono,ui-monospace);letter-spacing:.08em}
.step-text{color:var(--motion-ink,var(--ink,var(--text)));font-size:24px;line-height:1.3}
.scene-lockup{display:flex;align-items:center;gap:14px;color:var(--scene-accent);font:800 17px/1 var(--font-mono,ui-monospace);letter-spacing:.15em}
.scene-lockup i{display:block;width:88px;height:2px;background:linear-gradient(90deg,var(--scene-accent),var(--scene-accent-2))}
.scene-number{display:flex;align-items:baseline;gap:18px;color:var(--scene-accent)}
.scene-number strong{font:850 250px/.86 var(--font-mono,ui-monospace);letter-spacing:-.07em}
.scene-number span{color:var(--motion-muted,var(--mute));font:700 18px/1 var(--font-mono,ui-monospace);letter-spacing:.15em}
.scene-quote{max-width:980px;margin:0;padding-left:24px;border-left:5px solid var(--scene-accent);color:var(--motion-ink,var(--ink,var(--text)));font:750 52px/1.25 Georgia,"Songti SC",serif}
.scene-split{display:grid;grid-template-columns:1fr 44px 1fr;max-width:1120px;align-items:stretch;border-top:2px solid var(--motion-rule,var(--rule));border-bottom:2px solid var(--motion-rule,var(--rule))}
.scene-split>div{display:grid;gap:16px;align-content:center;min-height:170px;padding:26px 30px}
.scene-split>div.is-focus{background:color-mix(in srgb,var(--scene-accent) 12%,transparent)}
.scene-split small{color:var(--motion-muted,var(--mute));font:800 15px/1 var(--font-mono,ui-monospace);letter-spacing:.15em}
.scene-split strong{color:var(--motion-ink,var(--ink,var(--text)));font-size:32px;line-height:1.3}
.scene-split>i{width:1px;height:65%;align-self:center;background:var(--scene-accent)}
.scene-layers{display:grid;gap:10px;max-width:1000px}
.scene-layers .layer{display:grid;grid-template-columns:58px 1fr;gap:18px;align-items:center;padding:15px 20px;border-left:4px solid var(--scene-accent);border-bottom:1px solid var(--motion-rule,var(--rule));background:color-mix(in srgb,var(--scene-accent) 8%,transparent)}
.scene-layers .layer span{color:var(--scene-accent);font:800 16px/1 var(--font-mono,ui-monospace)}
.scene-layers .layer strong{color:var(--motion-ink,var(--ink,var(--text)));font-size:28px}
/* each variant changes the crop, hierarchy, and entrance—not just the accent */
.beat-hook-slam .scene{justify-content:center}
.beat-hook-slam .beat-title{max-width:1360px;font-size:144px}
.beat-hook-slam .scene-meta{margin-bottom:32px}
.beat-hook-slam .scene-copy::after{content:"";display:block;width:360px;height:9px;margin-top:34px;background:linear-gradient(90deg,var(--scene-accent),var(--scene-accent-2),transparent);transform:skewX(-26deg);transform-origin:left}
.beat-diagonal-reveal .scene{justify-content:flex-end;padding-bottom:150px}
.beat-diagonal-reveal .scene-copy{max-width:1320px;transform:rotate(-1.2deg)}
.beat-diagonal-reveal .beat-title{max-width:1240px;font-size:104px}
.beat-diagonal-reveal .scene-visual{padding-left:50px}
.beat-signal-bars .scene-copy{max-width:1420px}
.beat-signal-bars .beat-title{max-width:1000px}
.beat-signal-bars .scene-number strong{font-size:290px}
.beat-before-after .scene-copy{max-width:1460px}
.beat-before-after .scene-split{margin-top:10px}
.beat-stack-cascade .scene-copy{max-width:1340px}
.beat-stack-cascade .beat-title{max-width:1160px}
.beat-quote-cut .scene{justify-content:center;padding-left:204px}
.beat-quote-cut .beat-title{max-width:1200px;font:800 104px/1.06 Georgia,"Songti SC",serif;letter-spacing:-.03em}
.beat-quote-cut .scene-visual{margin-top:34px}
.beat-ticker-drive .scene-copy{max-width:1510px}
.beat-ticker-drive .beat-title{font-size:96px}
.beat-ticker-drive .scene-copy::before{content:"///";position:absolute;right:0;top:-70px;color:var(--scene-accent);font:800 24px/1 var(--font-mono,ui-monospace);letter-spacing:.2em}
.beat-closing-lock .scene{align-items:center;text-align:center}
.beat-closing-lock .scene-copy{max-width:1360px}
.beat-closing-lock .beat-title{max-width:1360px;font-size:106px}
.beat-closing-lock .scene-meta,.beat-closing-lock .scene-footer{width:100%;text-align:left}
.beat-broll .scene{align-items:center;justify-content:center;text-align:center}
.beat-broll .scene-copy{max-width:1280px}
.beat-broll .beat-title{font-size:86px}
.beat-broll .scene-meta,.beat-broll .scene-footer{width:100%}
/* real entrance motion, replayed by the requestAnimationFrame clock */
.beat.active.is-entering .backdrop-glow{animation:motion-glow-in 1.15s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .backdrop-line{animation:motion-line-in 1s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .scene-meta{animation:motion-meta-in .48s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .beat-title{animation:motion-title-in .72s .08s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .beat-body{animation:motion-body-in .62s .22s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .scene-visual{animation:motion-visual-in .72s .28s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .beat-steps .step.on:nth-child(1){animation:motion-step-in .52s .18s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .beat-steps .step.on:nth-child(2){animation:motion-step-in .52s .28s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .beat-steps .step.on:nth-child(3){animation:motion-step-in .52s .38s cubic-bezier(.16,1,.3,1) both}
.beat.active.is-entering .beat-steps .step.on:nth-child(4){animation:motion-step-in .52s .48s cubic-bezier(.16,1,.3,1) both}
.beat.motion-slam.active.is-entering .scene-copy{animation:motion-slam-in .78s cubic-bezier(.16,1,.3,1) both}
.beat.motion-wipe.active.is-entering .scene-copy{animation:motion-wipe-in .8s cubic-bezier(.16,1,.3,1) both}
.beat.motion-scan.active.is-entering .scene-visual{animation:motion-scan-in .8s cubic-bezier(.16,1,.3,1) both}
.beat.motion-cascade.active.is-entering .scene-visual{animation:motion-cascade-in .78s cubic-bezier(.16,1,.3,1) both}
.beat.motion-drift.active.is-entering .scene-copy{animation:motion-drift-in .8s cubic-bezier(.16,1,.3,1) both}
.beat.motion-type-on.active.is-entering .scene-copy{animation:motion-type-in .78s cubic-bezier(.16,1,.3,1) both}
.beat.motion-pulse.active.is-entering .scene-copy{animation:motion-pulse-in .82s cubic-bezier(.16,1,.3,1) both}
@keyframes motion-glow-in{from{opacity:0;transform:scale(.68)}to{opacity:.72;transform:none}}
@keyframes motion-line-in{from{opacity:0;transform:translateX(180px) rotate(-18deg)}to{opacity:.45;transform:rotate(-18deg)}}
@keyframes motion-meta-in{from{opacity:0;transform:translateY(-18px)}to{opacity:1;transform:none}}
@keyframes motion-title-in{from{opacity:0;filter:blur(12px);transform:translateY(62px) scale(.92)}to{opacity:1;filter:none;transform:none}}
@keyframes motion-body-in{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes motion-visual-in{from{opacity:0;transform:translateY(32px)}to{opacity:1;transform:none}}
@keyframes motion-step-in{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes motion-slam-in{from{opacity:0;transform:scale(.74) rotate(2deg)}to{opacity:1;transform:none}}
@keyframes motion-wipe-in{from{opacity:0;clip-path:inset(0 100% 0 0)}to{opacity:1;clip-path:inset(0)}}
@keyframes motion-scan-in{from{opacity:0;transform:translateX(90px)}to{opacity:1;transform:none}}
@keyframes motion-cascade-in{from{opacity:0;transform:translateY(64px) skewY(3deg)}to{opacity:1;transform:none}}
@keyframes motion-drift-in{from{opacity:0;transform:translateX(-80px)}to{opacity:1;transform:none}}
@keyframes motion-type-in{from{opacity:0;transform:scaleX(.72);transform-origin:left center}to{opacity:1;transform:none}}
@keyframes motion-pulse-in{from{opacity:0;transform:scale(1.14)}to{opacity:1;transform:none}}
/* structured style controls: generated options are rendered as real visual rules */
body.motion-typography-editorial .beat-title{font-family:Georgia,"Songti SC",serif;font-weight:760;letter-spacing:-.03em}
body.motion-typography-mono .beat-title{font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace);font-weight:760;letter-spacing:-.06em}
body.motion-typography-handwritten .beat-title{font-family:"Comic Sans MS","Kaiti SC",cursive;font-weight:700;letter-spacing:-.035em}
body.motion-density-airy .scene{padding:150px 190px}
body.motion-density-airy .beat-title{max-width:1400px;line-height:1.08;margin-bottom:78px}
body.motion-density-airy .beat-steps{gap:38px}
body.motion-density-dense .scene{padding:86px 116px}
body.motion-density-dense .beat-title{max-width:1600px;font-size:76px;line-height:1.12;margin-bottom:42px}
body.motion-density-dense .beat-body{margin-bottom:34px;font-size:26px}
body.motion-density-dense .beat-steps{gap:16px}
body.motion-intensity-calm .beat.active.is-entering .scene-copy,
body.motion-intensity-calm .beat.active.is-entering .scene-visual{animation-duration:1.08s}
body.motion-intensity-explosive .beat.active.is-entering .scene-copy,
body.motion-intensity-explosive .beat.active.is-entering .scene-visual{animation-duration:.48s}
body.motion-intensity-explosive .beat-title{font-weight:820;letter-spacing:-.075em}
@media (max-width:1100px){.scene{padding:92px 88px 72px}.beat-title{font-size:82px}.beat-hook-slam .beat-title{font-size:106px}.beat-quote-cut .scene{padding-left:120px}.beat-quote-cut .beat-title{font-size:80px}.scene-number strong{font-size:190px}}
@media (max-width:900px){.scene{padding:76px 56px 60px}.scene-meta{margin-bottom:26px}.beat-kicker{font-size:15px}.scene-counter,.scene-footer{font-size:11px}.beat-title,.beat-hook-slam .beat-title,.beat-diagonal-reveal .beat-title,.beat-quote-cut .beat-title,.beat-closing-lock .beat-title{font-size:58px}.beat-body{font-size:19px}.scene-visual{margin-top:28px}.step-text{font-size:18px}.scene-number strong{font-size:140px}.scene-split{grid-template-columns:1fr 22px 1fr}.scene-split>div{min-height:120px;padding:16px}.scene-split strong{font-size:20px}.scene-quote{font-size:31px}.beat-broll .beat-title{font-size:52px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}.beat.active.is-entering .beat-title,.beat.active.is-entering .scene-copy,.beat.active.is-entering .scene-visual,.step{opacity:1!important;transform:none!important;filter:none!important;clip-path:none!important}}
`;
}

/** 独立页复用播放器 Motion v2 的视觉层，避免两个入口各自演化。 */
function playerMotionCss(): string {
  return String.raw`
.qq-motion-canvas{position:absolute;inset:0;overflow:hidden;padding:0;--motion-ink:#f5f5f7;--motion-muted:rgba(245,245,247,.58);--motion-rule:rgba(255,255,255,.16);--motion-paper:#090a0c;--motion-accent:#e85d36;--motion-accent-2:#fbbf24;color:#f6f7fb;background:radial-gradient(circle at 72% 48%,color-mix(in srgb,var(--motion-accent) 26%,transparent),transparent 32%),linear-gradient(135deg,#101320,#080910 72%);isolation:isolate}
.qq-motion-canvas::before{content:"";position:absolute;z-index:0;inset:-30%;pointer-events:none;background:linear-gradient(122deg,transparent 0 48%,color-mix(in srgb,var(--motion-accent) 15%,transparent) 48.2% 49%,transparent 49.2%),radial-gradient(ellipse at 12% 78%,color-mix(in srgb,var(--motion-accent-2) 13%,transparent),transparent 32%);transform:rotate(-4deg)}
.qq-motion-canvas::after{content:"";position:absolute;left:6%;right:6%;bottom:8%;height:1px;background:linear-gradient(90deg,var(--motion-accent),transparent);opacity:.65}
.qq-motion-canvas.motion-style-editorial-magazine{--motion-ink:#171717;--motion-muted:#67635c;--motion-rule:rgba(23,23,23,.18);--motion-paper:#f2eee7;--motion-accent:#b91c1c;color:var(--motion-ink);background:var(--motion-paper)}
.qq-motion-canvas.motion-style-editorial-magazine::before,.qq-motion-canvas.motion-style-newspaper-evidence::before{background:repeating-linear-gradient(90deg,transparent 0 13%,rgba(23,23,23,.035) 13.05% 13.1%)}
.qq-motion-canvas.motion-style-sketch-note{--motion-ink:#25231f;--motion-muted:#777067;--motion-rule:rgba(37,35,31,.26);--motion-paper:#f5f1e8;--motion-accent:#d92d20;color:var(--motion-ink);background-color:var(--motion-paper);background-image:linear-gradient(rgba(71,115,143,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(71,115,143,.09) 1px,transparent 1px);background-size:24px 24px}
.qq-motion-canvas.motion-style-finance-studio-cards{--motion-ink:#ecfeff;--motion-muted:rgba(236,254,255,.56);--motion-rule:rgba(45,212,191,.24);--motion-paper:#071415;--motion-accent:#2dd4bf;background:linear-gradient(135deg,#091b1e,#061012 76%)}
.qq-motion-canvas.motion-style-newspaper-evidence{--motion-ink:#232323;--motion-muted:#6d685e;--motion-rule:rgba(35,35,35,.22);--motion-paper:#ebe5d8;--motion-accent:#b91c1c;color:var(--motion-ink);background:var(--motion-paper)}
.qq-motion-canvas.motion-style-paper-collage{--motion-ink:#211d1a;--motion-muted:#6d6259;--motion-rule:rgba(33,29,26,.2);--motion-paper:#f3ead9;--motion-accent:#e85d36;color:var(--motion-ink);background:#f3ead9}
.qq-motion-canvas.motion-style-paper-collage::before{inset:10% 8% 14% 42%;transform:rotate(3deg);background:#f9f2e6;box-shadow:12px 14px 0 rgba(33,29,26,.1)}
.qq-motion-canvas-top,.qq-motion-canvas-footer{position:absolute;left:6%;right:6%;z-index:4;display:flex;justify-content:space-between;gap:10px;color:var(--motion-muted,rgba(255,255,255,.55));font:700 11px var(--font-mono,ui-monospace);letter-spacing:.12em;text-transform:uppercase}
.qq-motion-canvas-top{top:5.5%}.qq-motion-canvas-footer{bottom:5%;border-top:1px solid var(--motion-rule);padding-top:10px}
.qq-motion-canvas-top span:first-child{color:var(--motion-accent)}
.qq-motion-canvas-grid{position:absolute;inset:0;z-index:0;opacity:.25;background-image:linear-gradient(color-mix(in srgb,var(--motion-accent) 10%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--motion-accent) 10%,transparent) 1px,transparent 1px);background-size:10% 20%;mask-image:linear-gradient(120deg,#000 0%,transparent 78%)}
.js .qq-motion-canvas .beat{position:absolute;inset:0;display:none;z-index:1}.js .qq-motion-canvas .beat.active{display:block}
.qq-motion-canvas .qq-motion-scene{position:absolute;z-index:2;inset:19% 7% 16%;display:grid;grid-template-columns:9% minmax(0,1fr);align-items:start;gap:2%}
.qq-motion-canvas .qq-motion-scene-index{align-self:start;color:var(--motion-accent);font:800 clamp(30px,6.8vw,96px) var(--font-mono,ui-monospace);letter-spacing:0;opacity:.9}
.qq-motion-canvas .qq-motion-scene-copy{max-width:100%}
.qq-motion-canvas .qq-motion-scene-copy h4{max-width:980px;margin:0;color:var(--motion-ink);font-size:clamp(22px,5.2vw,78px);line-height:1.02;letter-spacing:-.055em;font-weight:850;word-break:keep-all;text-wrap:balance}
.qq-motion-canvas .qq-motion-scene-copy p{max-width:680px;margin:4% 0 0;color:var(--motion-muted);font-size:clamp(12px,1.2vw,17px);line-height:1.6}
.qq-motion-canvas .qq-motion-live-lockup,.qq-motion-canvas .qq-motion-live-quote,.qq-motion-canvas .qq-motion-live-number,.qq-motion-canvas .qq-motion-live-path,.qq-motion-canvas .qq-motion-live-split,.qq-motion-canvas .qq-motion-live-layers{margin-top:6%}
.qq-motion-canvas .qq-motion-live-lockup{display:flex;align-items:center;gap:10px;color:var(--motion-accent);font:800 10px var(--font-mono,ui-monospace);letter-spacing:.12em}
.qq-motion-canvas .qq-motion-live-lockup i{display:block;width:54px;height:1px;background:var(--motion-accent)}
.qq-motion-canvas .qq-motion-live-quote{max-width:860px;margin-left:0;padding-left:16px;border-left:3px solid var(--motion-accent);color:var(--motion-ink);font:650 clamp(16px,2.2vw,31px)/1.35 Georgia,"Songti SC",serif}
.qq-motion-canvas .qq-motion-live-number{display:flex;align-items:baseline;gap:12px;color:var(--motion-accent)}
.qq-motion-canvas .qq-motion-live-number strong{font:800 clamp(42px,9vw,130px) var(--font-mono,ui-monospace);letter-spacing:-.05em}.qq-motion-canvas .qq-motion-live-number span{color:var(--motion-muted);font:700 10px var(--font-mono,ui-monospace);letter-spacing:.12em}
.qq-motion-canvas .qq-motion-live-path{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;max-width:900px}
.qq-motion-canvas .qq-motion-live-path-item{position:relative;min-width:0;padding:12px 16px 0 0;border-top:2px solid color-mix(in srgb,var(--motion-accent) 72%,transparent)}
.qq-motion-canvas .qq-motion-live-path-item>span{display:block;margin-bottom:7px;color:var(--motion-accent);font:700 10px var(--font-mono,ui-monospace)}
.qq-motion-canvas .qq-motion-live-path-item strong{display:block;color:var(--motion-ink);font-size:clamp(10px,1.25vw,16px);line-height:1.3}.qq-motion-canvas .qq-motion-live-path-item>i{position:absolute;top:5px;left:35px;right:12px;height:1px;background:var(--motion-accent);opacity:.65}
.qq-motion-canvas .qq-motion-live-split{display:grid;grid-template-columns:1fr 24px 1fr;max-width:860px;align-items:stretch;border-top:1px solid var(--motion-rule);border-bottom:1px solid var(--motion-rule)}
.qq-motion-canvas .qq-motion-live-split>div{display:grid;gap:8px;align-content:center;min-height:68px;padding:12px 16px}.qq-motion-canvas .qq-motion-live-split>div.is-focus{background:color-mix(in srgb,var(--motion-accent) 10%,transparent)}
.qq-motion-canvas .qq-motion-live-split small{color:var(--motion-muted);font:700 9px var(--font-mono,ui-monospace);letter-spacing:.12em}.qq-motion-canvas .qq-motion-live-split strong{color:var(--motion-ink);font-size:clamp(10px,1.2vw,15px)}.qq-motion-canvas .qq-motion-live-split>i{width:1px;height:70%;align-self:center;background:var(--motion-rule)}
.qq-motion-canvas .qq-motion-live-layers{display:grid;gap:7px;max-width:820px}.qq-motion-canvas .qq-motion-live-layers div{display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:center;padding:9px 12px;border-left:3px solid var(--motion-accent);border-bottom:1px solid var(--motion-rule);background:color-mix(in srgb,var(--motion-accent) 8%,transparent)}.qq-motion-canvas .qq-motion-live-layers span{color:var(--motion-accent);font:700 9px var(--font-mono,ui-monospace)}.qq-motion-canvas .qq-motion-live-layers strong{color:var(--motion-ink);font-size:clamp(10px,1.2vw,15px)}
.qq-motion-canvas .qq-motion-scene.is-closing{grid-template-columns:1fr;text-align:center}.qq-motion-canvas .qq-motion-scene.is-closing .qq-motion-scene-index{position:absolute;top:-18%;right:0;opacity:.2}.qq-motion-canvas .qq-motion-scene.is-closing .qq-motion-scene-copy{max-width:1360px;margin:auto}.qq-motion-canvas .qq-motion-scene.is-variant-closing-lock{inset:22% 8% 14%;grid-template-columns:1fr;text-align:center}.qq-motion-canvas .qq-motion-scene.is-variant-closing-lock .qq-motion-scene-index{position:absolute;top:-19%;right:0;opacity:.22}.qq-motion-canvas .qq-motion-scene.is-variant-closing-lock .qq-motion-scene-copy h4{max-width:920px;margin-inline:auto}
.qq-motion-canvas .qq-motion-scene.is-variant-hook-slam{inset:18% 6% 14%}.qq-motion-canvas .qq-motion-scene.is-variant-hook-slam .qq-motion-scene-copy h4{max-width:1050px;font-size:clamp(28px,6.4vw,94px)}.qq-motion-canvas .qq-motion-scene.is-variant-hook-slam .qq-motion-scene-copy::after{content:"";display:block;width:34%;height:3px;margin-top:7%;background:linear-gradient(90deg,var(--motion-accent),var(--motion-accent-2,#fbbf24),transparent);transform:skewX(-28deg);transform-origin:left}
.qq-motion-canvas .qq-motion-scene.is-variant-diagonal-reveal{inset:25% 8% 13%;align-items:end}.qq-motion-canvas .qq-motion-scene.is-variant-diagonal-reveal .qq-motion-scene-copy{transform:rotate(-1.4deg)}.qq-motion-canvas .qq-motion-scene.is-variant-diagonal-reveal .qq-motion-scene-copy h4{max-width:860px}
.qq-motion-canvas .qq-motion-scene.is-variant-signal-bars{inset:19% 6% 13%}.qq-motion-canvas .qq-motion-scene.is-variant-signal-bars .qq-motion-scene-copy h4{max-width:740px}.qq-motion-canvas .qq-motion-scene.is-variant-signal-bars::after{content:"";position:absolute;right:0;bottom:7%;width:42%;height:36%;border-top:1px solid color-mix(in srgb,var(--motion-accent) 56%,transparent);border-right:1px solid color-mix(in srgb,var(--motion-accent) 32%,transparent);transform:skewY(-9deg);opacity:.72}
.qq-motion-canvas .qq-motion-scene.is-variant-before-after .qq-motion-scene-copy h4{max-width:920px}.qq-motion-canvas .qq-motion-scene.is-variant-stack-cascade{inset:20% 6% 13%}.qq-motion-canvas .qq-motion-scene.is-variant-stack-cascade .qq-motion-scene-copy h4{max-width:820px}.qq-motion-canvas .qq-motion-scene.is-variant-quote-cut{inset:19% 5% 14%}.qq-motion-canvas .qq-motion-scene.is-variant-quote-cut .qq-motion-scene-copy{padding-left:4%}.qq-motion-canvas .qq-motion-scene.is-variant-quote-cut .qq-motion-scene-copy h4{max-width:900px;font-family:Georgia,"Songti SC",serif;font-weight:760;letter-spacing:-.03em}
.qq-motion-canvas .qq-motion-scene.is-variant-ticker-drive .qq-motion-scene-copy::before{content:"///";display:block;margin-bottom:6%;color:var(--motion-accent);font:800 24px var(--font-mono,ui-monospace);letter-spacing:.24em}.qq-motion-canvas .qq-motion-scene.is-variant-ticker-drive .qq-motion-scene-copy::after{content:"";display:block;width:100%;height:1px;margin-top:7%;background:repeating-linear-gradient(90deg,var(--motion-accent) 0 22px,transparent 22px 34px);animation:qq-motion-ticker-line 1.8s cubic-bezier(.16,1,.3,1) both}
.qq-motion-canvas .qq-motion-scene.is-motion-slam.active,.qq-motion-canvas .qq-motion-scene.is-motion-wipe.active,.qq-motion-canvas .qq-motion-scene.is-motion-scan.active,.qq-motion-canvas .qq-motion-scene.is-motion-cascade.active,.qq-motion-canvas .qq-motion-scene.is-motion-drift.active,.qq-motion-canvas .qq-motion-scene.is-motion-type-on.active,.qq-motion-canvas .qq-motion-scene.is-motion-pulse.active{animation-fill-mode:both}
.qq-motion-canvas .beat.active.is-entering .qq-motion-scene{animation:qq-motion-scene-in .72s cubic-bezier(.16,1,.3,1) both}.qq-motion-canvas .beat.motion-slam.active.is-entering .qq-motion-scene{animation-name:qq-motion-slam-in}.qq-motion-canvas .beat.motion-wipe.active.is-entering .qq-motion-scene{animation-name:qq-motion-wipe-in}.qq-motion-canvas .beat.motion-scan.active.is-entering .qq-motion-scene{animation-name:qq-motion-scan-in}.qq-motion-canvas .beat.motion-cascade.active.is-entering .qq-motion-scene{animation-name:qq-motion-cascade-in}.qq-motion-canvas .beat.motion-drift.active.is-entering .qq-motion-scene{animation-name:qq-motion-drift-in}.qq-motion-canvas .beat.motion-type-on.active.is-entering .qq-motion-scene{animation-name:qq-motion-type-in}.qq-motion-canvas .beat.motion-pulse.active.is-entering .qq-motion-scene{animation-name:qq-motion-pulse-in}
.qq-motion-canvas [data-step-index]{opacity:0;transform:translateY(18px);transition:opacity .44s cubic-bezier(.16,1,.3,1),transform .58s cubic-bezier(.16,1,.3,1)}.qq-motion-canvas [data-step-index].is-visible{opacity:1;transform:none}.qq-motion-canvas.motion-style-editorial-magazine .qq-motion-live-quote,.qq-motion-canvas.motion-style-newspaper-evidence .qq-motion-live-quote{border-left-width:4px}.qq-motion-canvas.motion-style-sketch-note .qq-motion-live-split,.qq-motion-canvas.motion-style-sketch-note .qq-motion-live-layers{border-style:dashed}.qq-motion-canvas.motion-style-paper-collage .qq-motion-live-split>div{box-shadow:4px 5px 0 rgba(33,29,26,.12)}
body.motion-typography-editorial .qq-motion-scene-copy h4{font-family:Georgia,"Songti SC",serif;font-weight:760;letter-spacing:-.03em}body.motion-typography-mono .qq-motion-scene-copy h4{font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace);font-weight:760;letter-spacing:-.06em}body.motion-typography-handwritten .qq-motion-scene-copy h4{font-family:"Comic Sans MS","Kaiti SC",cursive;font-weight:700;letter-spacing:-.035em}
body.motion-density-airy .qq-motion-scene{inset:16% 8% 14%}body.motion-density-airy .qq-motion-scene-copy h4{max-width:1080px;line-height:1.08}body.motion-density-airy .qq-motion-live-lockup,body.motion-density-airy .qq-motion-live-quote,body.motion-density-airy .qq-motion-live-number,body.motion-density-airy .qq-motion-live-path,body.motion-density-airy .qq-motion-live-split,body.motion-density-airy .qq-motion-live-layers{margin-top:8%}body.motion-density-dense .qq-motion-scene{inset:21% 5% 13%}body.motion-density-dense .qq-motion-scene-copy h4{max-width:1160px;font-size:clamp(20px,4.5vw,68px)}body.motion-density-dense .qq-motion-live-lockup,body.motion-density-dense .qq-motion-live-quote,body.motion-density-dense .qq-motion-live-number,body.motion-density-dense .qq-motion-live-path,body.motion-density-dense .qq-motion-live-split,body.motion-density-dense .qq-motion-live-layers{margin-top:4%}body.motion-intensity-calm .qq-motion-scene{animation-duration:1.1s}body.motion-intensity-explosive .qq-motion-scene-copy h4{font-weight:820;letter-spacing:-.075em}body.motion-intensity-explosive .qq-motion-scene-index{transform:scale(1.12);transform-origin:top left}
@keyframes qq-motion-scene-in{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}@keyframes qq-motion-slam-in{from{opacity:0;transform:scale(.78) rotate(2deg);filter:blur(8px)}to{opacity:1;transform:none;filter:none}}@keyframes qq-motion-wipe-in{from{opacity:0;clip-path:inset(0 100% 0 0)}to{opacity:1;clip-path:inset(0)}}@keyframes qq-motion-scan-in{from{opacity:0;transform:translateX(72px)}to{opacity:1;transform:none}}@keyframes qq-motion-cascade-in{from{opacity:0;transform:translateY(56px) skewY(3deg)}to{opacity:1;transform:none}}@keyframes qq-motion-drift-in{from{opacity:0;transform:translateX(-66px)}to{opacity:1;transform:none}}@keyframes qq-motion-type-in{from{opacity:0;transform:scaleX(.76);transform-origin:left center}to{opacity:1;transform:none}}@keyframes qq-motion-pulse-in{from{opacity:0;transform:scale(1.12)}to{opacity:1;transform:none}}@keyframes qq-motion-ticker-line{from{transform:translateX(-30%);opacity:0}to{transform:none;opacity:1}}
@media (max-width:1100px){.qq-motion-canvas .qq-motion-scene-copy h4{font-size:58px}.qq-motion-canvas .qq-motion-live-number strong{font-size:190px}.qq-motion-canvas .qq-motion-live-quote{font-size:38px}.qq-motion-canvas .qq-motion-live-split>div strong{font-size:24px}}
@media (prefers-reduced-motion:reduce){.qq-motion-canvas *, .qq-motion-canvas *::before, .qq-motion-canvas *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}.qq-motion-canvas .beat.active.is-entering .qq-motion-scene{opacity:1!important;transform:none!important;filter:none!important;clip-path:none!important}}
`;
}

/** 生成单文件 HTML（时间属性由已确认时间轴直接内联） */
export function renderMotionHtml(timeline: MotionTimeline, jobId: string): string {
  const [c1, c2] = gradientPair(jobId);
  const pageStyle = timeline.page?.style || 'editorial-magazine';
  const styleOptions = timeline.page?.styleOptions;
  const typography = styleOptions?.typography || 'auto';
  const density = styleOptions?.density || 'balanced';
  const intensity = styleOptions?.intensity || 'dynamic';
  const beatsHtml = timeline.beats
    .map((beat, index) =>
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
        scene: timeline.page?.scenes.find((scene) => scene.beatId === beat.id),
        index,
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
#motionAudio{display:none}
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
.beat-body{max-width:980px;margin-top:-42px;margin-bottom:54px;
  font-size:30px;line-height:1.55;color:var(--mute)}
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
.audio-unlock{position:absolute;left:50%;bottom:74px;z-index:110;transform:translateX(-50%);padding:14px 26px;border:1px solid rgba(255,255,255,.24);border-radius:999px;background:rgba(8,10,18,.82);color:#fff;font-size:20px;font-weight:700;cursor:pointer;box-shadow:0 12px 40px rgba(0,0,0,.28);backdrop-filter:blur(14px)}
.audio-unlock[hidden]{display:none}
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
.autoplay-audio-status{max-width:900px;color:#fca5a5;font-size:20px;line-height:1.45}
.autoplay-audio-status[hidden]{display:none}
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
<style>${css}${richMotionCss()}${kineticMotionCss()}${playerMotionCss()}</style>
</head>
<body class="js style-${esc(pageStyle)} motion-typography-${esc(typography)} motion-density-${esc(density)} motion-intensity-${esc(intensity)}" data-motion-job="${esc(jobId)}">
<div id="stage">
<div class="qq-motion-canvas motion-style-${esc(pageStyle)} motion-typography-${esc(typography)} motion-density-${esc(density)} motion-intensity-${esc(intensity)}" data-motion-renderer="player-v2">
  <div class="qq-motion-canvas-grid" aria-hidden="true"></div>
  <div class="qq-motion-canvas-top">
    <span id="motionCanvasKicker">MOTION</span>
    <span id="motionCanvasClock">00:00.000 / ${formatMotionClock(durationMs)}</span>
  </div>
${beatsHtml}
<div class="qq-motion-canvas-footer">
  <span id="motionCanvasMode">${timeline.page?.source === 'ai' ? 'AI' : 'MOTION'} · ${esc(pageStyle)}</span>
  <span>${esc(timeline.title)}</span>
</div>
</div>
<div class="hud">
  <div class="hud-dots" id="hudDots">${timeline.beats.map(() => '<span class="hud-dot"></span>').join('')}</div>
  <span id="hudTime">00:00.000 / ${formatMotionClock(durationMs)}</span>
</div>
<button class="audio-unlock" id="audioUnlock" hidden>点击启用声音</button>
</div>
<audio id="motionAudio" preload="auto" aria-hidden="true"></audio>
<div class="autoplay-gate" id="autoplayGate">
  <div class="autoplay-panel">
    <div class="autoplay-kicker">MOTION · ${esc(timeline.title)}</div>
    <h1 class="autoplay-title">${esc(timeline.title)}</h1>
    <button class="autoplay-start" id="autoplayStart">播放并启用声音</button>
    <div class="autoplay-controls">空格 暂停/继续 · ←/→ 跳 5 秒 · R 重播 · F 全屏</div>
    <div class="autoplay-audio-status" id="autoplayAudioStatus" hidden></div>
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
  const html = renderMotionHtml(timeline, jobId);
  const check = validateMotionHtml(html, timeline);
  if (!check.ok) {
    return { ok: false, error: `HTML 产物校验失败：${check.errors.join('; ')}` };
  }
  const confirmed = await confirmTimeline(jobId, timeline);
  if (!confirmed.ok) {
    const codes = confirmed.gate.violations.map((v) => v.code).join(', ');
    return { ok: false, error: `时间轴未通过确认门：${codes}` };
  }
  const file = jobPaths(jobId).motionHtml;
  await fs.writeFile(file, html, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');
  return { ok: true, file, bytes };
}
