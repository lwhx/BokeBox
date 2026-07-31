import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { hashSeed } from '../../lib/format';
import type { TagStar } from './types';
export type { TagStar } from './types';
import {
  ZERO,
  WHITE,
  attachStarShader,
  buildLinkPairs,
  clusterPositions,
  colorForTag,
  detectQuality,
  detectUniverseMode,
  makeBandTexture,
  makeCelestialGrid,
  makeRadialTexture,
  makeSpaceBgTexture,
  makeSpikeTexture,
  makeStarfield,
  resolveUniverseTheme,
  setStarVisual,
  type StarRuntime,
  type UniverseMode,
} from './universeKit';

type Props = {
  tags: TagStar[];
  selected?: string | null;
  onSelect: (name: string | null) => void;
  /** WebGL 首帧绘制完成后回调，用于收起加载层 */
  onReady?: () => void;
  className?: string;
};

type UniverseApi = {
  /** 聚焦星座连线（共现关联） */
  rebuildFocus: (name: string | null) => void;
};

export function TagUniverse({ tags, selected, onSelect, onReady, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const onReadyRef = useRef(onReady);
  const selectedRef = useRef(selected);
  const starsRef = useRef<StarRuntime[]>([]);
  const hoverRef = useRef<string | null>(null);
  const apiRef = useRef<UniverseApi | null>(null);
  const themeModeRef = useRef<UniverseMode>(detectUniverseMode());

  const tagKey = useMemo(
    () => tags.map((t) => `${t.name}:${t.count}`).join('|'),
    [tags],
  );

  // 跟随站点亮/暗主题重建星图（亮色印谱纸面 / 暗色夜空）
  const [themeMode, setThemeMode] = useState<UniverseMode>(() => detectUniverseMode());

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const next = detectUniverseMode();
      themeModeRef.current = next;
      setThemeMode(next);
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    selectedRef.current = selected;
    apiRef.current?.rebuildFocus(selected ?? null);
    for (const s of starsRef.current) {
      const active = Boolean(selected && s.name === selected);
      if (s.label) s.label.element.classList.toggle('is-focus', active);
    }
  }, [selected]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let disposed = false;
    let ignoreCanvasPickUntil = 0;
    const quality = detectQuality();

    const theme = resolveUniverseTheme(themeMode);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(theme.bg, theme.fogDensity);

    const bgTex = makeSpaceBgTexture(theme.mode);
    scene.background = bgTex;

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 180);
    camera.position.set(0.55, 1.65, 15.2);

    const renderer = new THREE.WebGLRenderer({
      antialias: quality.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    renderer.setPixelRatio(quality.dpr);
    renderer.setClearColor(theme.bg, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    wrap.appendChild(renderer.domElement);
    renderer.domElement.className = 'tu-canvas';

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = 'tu-labels';
    wrap.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.rotateSpeed = 0.46;
    controls.zoomSpeed = 0.72;
    controls.minDistance = 6;
    controls.maxDistance = 34;
    controls.enablePan = false;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.12;
    controls.target.copy(ZERO);

    const dustTex = makeRadialTexture(
      [
        [0, 'rgba(255,255,255,1)'],
        [0.18, 'rgba(255,255,255,0.72)'],
        [0.45, 'rgba(255,255,255,0.18)'],
        [0.78, 'rgba(255,255,255,0.04)'],
        [1, 'rgba(255,255,255,0)'],
      ],
      64,
    );

    const shaderUniforms = {
      uTime: { value: 0 },
      uTwinkle: { value: quality.twinkle ? 1 : 0 },
    };

    // 远景星场
    const farGeo = makeStarfield({
      count: quality.farStars,
      rMin: 24,
      rMax: 72,
      seed: 11,
    });
    const farMat = new THREE.PointsMaterial({
      size: theme.mode === 'light' ? 0.07 : 0.055,
      map: dustTex,
      vertexColors: true,
      transparent: true,
      opacity: theme.starOpacity,
      depthWrite: false,
      blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    if (quality.twinkle) attachStarShader(farMat, shaderUniforms);
    const farPoints = new THREE.Points(farGeo, farMat);
    scene.add(farPoints);

    // 银河盘面星云
    const milkyGeo = makeStarfield({
      count: quality.milkyStars,
      rMin: 14,
      rMax: 58,
      milky: true,
      seed: 29,
    });
    const milkyMat = new THREE.PointsMaterial({
      size: theme.mode === 'light' ? 0.09 : 0.07,
      map: dustTex,
      vertexColors: true,
      transparent: true,
      opacity: theme.milkyOpacity,
      depthWrite: false,
      blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    if (quality.twinkle) attachStarShader(milkyMat, shaderUniforms);
    const milkyPoints = new THREE.Points(milkyGeo, milkyMat);
    milkyPoints.rotation.z = 0.18;
    scene.add(milkyPoints);

    // 近景亮星
    const nearGeo = makeStarfield({
      count: quality.nearStars,
      rMin: 9,
      rMax: 24,
      seed: 47,
    });
    const nearMat = new THREE.PointsMaterial({
      size: theme.mode === 'light' ? 0.14 : 0.11,
      map: dustTex,
      vertexColors: true,
      transparent: true,
      opacity: theme.nearOpacity,
      depthWrite: false,
      blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    if (quality.twinkle) attachStarShader(nearMat, shaderUniforms);
    const nearPoints = new THREE.Points(nearGeo, nearMat);
    scene.add(nearPoints);

    // 星尘微粒（更软、更大）；低画质可关掉
    let dustPoints: THREE.Points | null = null;
    let dustSoftTex: THREE.CanvasTexture | null = null;
    if (quality.dustPoints > 0) {
      const dustGeo = makeStarfield({
        count: quality.dustPoints,
        rMin: 8,
        rMax: 30,
        milky: true,
        seed: 73,
      });
      dustSoftTex = makeRadialTexture(
        [
          [0, 'rgba(200,220,255,0.55)'],
          [0.4, 'rgba(140,170,255,0.12)'],
          [1, 'rgba(255,255,255,0)'],
        ],
        64,
      );
      const dustMat = new THREE.PointsMaterial({
        size: theme.mode === 'light' ? 0.48 : 0.55,
        map: dustSoftTex,
        vertexColors: true,
        transparent: true,
        opacity: theme.dustOpacity,
        depthWrite: false,
        blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      dustPoints = new THREE.Points(dustGeo, dustMat);
      scene.add(dustPoints);
    }

    // 天球经纬网格（星表气质）
    const gridColor = theme.mode === 'light' ? 0x5f7394 : 0x6a86b8;
    const gridGroup = makeCelestialGrid(14.5, gridColor, theme.gridOpacity, !quality.animateIdle);
    scene.add(gridGroup);

    // 银河雾带：柔和的光带，点缀夜空 / 印谱纸面
    const band = makeBandTexture(4);
    const bandMat = new THREE.MeshBasicMaterial({
      map: band.texture,
      color: theme.mode === 'light' ? 0xa9bcd6 : 0xffffff,
      transparent: true,
      opacity: theme.bandOpacity,
      depthWrite: false,
      blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    const bandMesh = new THREE.Mesh(new THREE.PlaneGeometry(30, 11), bandMat);
    bandMesh.position.set(0, -3.6, 0);
    bandMesh.rotation.x = -1.12;
    bandMesh.rotation.z = 0.3;
    scene.add(bandMesh);

    const glowTex = makeRadialTexture(
      [
        [0, 'rgba(255,255,255,1)'],
        [0.1, 'rgba(255,255,255,0.92)'],
        [0.28, 'rgba(255,255,255,0.38)'],
        [0.55, 'rgba(255,255,255,0.1)'],
        [0.82, 'rgba(255,255,255,0.02)'],
        [1, 'rgba(255,255,255,0)'],
      ],
      160,
    );
    const coronaTex = makeRadialTexture(
      [
        [0, 'rgba(255,255,255,0.95)'],
        [0.2, 'rgba(255,255,255,0.45)'],
        [0.55, 'rgba(255,255,255,0.08)'],
        [1, 'rgba(255,255,255,0)'],
      ],
      96,
    );
    const spikeTex = makeSpikeTexture();
    const coreGeo = new THREE.SphereGeometry(1, 10, 10);
    const planeGeo = new THREE.PlaneGeometry(1, 1);

    const root = new THREE.Group();
    scene.add(root);

    const maxCount = Math.max(1, ...tags.map((t) => t.count));
    const radius = Math.max(4.6, Math.min(10.2, 3.4 + Math.sqrt(Math.max(tags.length, 1)) * 0.95));
    // 星座聚类：共现节目的标签彼此靠近
    const positions = clusterPositions(tags, radius);
    const runtimes: StarRuntime[] = [];
    const maxLabels = quality.animateIdle ? 20 : 12;
    const topNames = new Set(
      [...tags]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
        .slice(0, maxLabels)
        .map((t) => t.name),
    );
    const glowBlend =
      theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;
    const richStars = quality.animateIdle;
    const leaderColor = theme.mode === 'light' ? 0x46566b : 0xa9c0e8;
    const topCut = Math.max(2, Math.round(maxCount * 0.22));

    const attachLabel = (s: StarRuntime, focused = false) => {
      if (s.label) {
        s.label.visible = true;
        s.label.element.style.display = '';
        s.label.element.classList.toggle('is-focus', focused);
        if (s.leader) s.leader.visible = true;
        return s.label;
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tu-label' + (focused ? ' is-focus' : '');
      const dot = document.createElement('span');
      dot.className = 'tu-label-dot';
      const text = document.createElement('span');
      text.className = 'tu-label-text';
      text.textContent = s.name;
      const count = document.createElement('span');
      count.className = 'tu-label-count';
      count.textContent = String(s.count);
      el.append(dot, text, count);
      el.style.setProperty('--star', `#${s.color.getHexString()}`);
      el.dataset.tagName = s.name;
      el.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        ignoreCanvasPickUntil = performance.now() + 500;
      });
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ignoreCanvasPickUntil = performance.now() + 500;
        const next = selectedRef.current === s.name ? null : s.name;
        onSelectRef.current(next);
      });
      const label = new CSS2DObject(el);
      label.position.set(0, s.baseScale * 2.0, 0);
      s.group.add(label);
      s.label = label;
      if (s.leader) s.leader.visible = true;
      return label;
    };

    tags.forEach((tag, i) => {
      const color = colorForTag(tag.name);
      if (theme.mode === 'light') {
        color.offsetHSL(0, 0.14, -0.04);
      }
      const weight = tag.count / maxCount;
      const baseScale = 0.12 + weight * 0.28 + 0.04;

      const group = new THREE.Group();
      group.position.copy(positions[i]);
      group.userData.name = tag.name;
      group.matrixAutoUpdate = false;
      group.updateMatrix();

      const core = new THREE.Mesh(
        coreGeo,
        new THREE.MeshBasicMaterial({
          color: theme.mode === 'light' ? color.clone().lerp(WHITE, 0.18) : WHITE,
          transparent: true,
          opacity: theme.mode === 'light' ? 1 : 0.98,
        }),
      );
      core.scale.setScalar(baseScale * (theme.mode === 'light' ? 0.58 : 0.52));
      core.matrixAutoUpdate = true;

      const corona = new THREE.Mesh(
        planeGeo,
        new THREE.MeshBasicMaterial({
          map: coronaTex,
          color,
          transparent: true,
          opacity: theme.mode === 'light' ? 0.72 : 0.34,
          depthWrite: false,
          blending: glowBlend,
        }),
      );
      corona.scale.setScalar(baseScale * (theme.mode === 'light' ? 3.0 : 2.7));
      corona.visible = richStars;

      const halo = new THREE.Mesh(
        planeGeo,
        new THREE.MeshBasicMaterial({
          map: glowTex,
          color,
          transparent: true,
          opacity: theme.mode === 'light' ? 0.78 : 0.86,
          depthWrite: false,
          blending: glowBlend,
        }),
      );
      halo.scale.setScalar(baseScale * (theme.mode === 'light' ? 8.0 : 7.4));

      // 衍射十字仅给亮星，数量可控
      const spike = new THREE.Mesh(
        planeGeo,
        new THREE.MeshBasicMaterial({
          map: spikeTex,
          color,
          transparent: true,
          opacity: theme.mode === 'light' ? 0.4 + weight * 0.28 : 0.18 + weight * 0.28,
          depthWrite: false,
          blending: glowBlend,
        }),
      );
      spike.scale.setScalar(baseScale * 11.2);
      spike.visible = richStars && tag.count >= topCut;

      // 引线：星体 → 标签基线（星表样式）
      const leaderGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, baseScale * 1.0, 0),
        new THREE.Vector3(0, baseScale * 1.75, 0),
      ]);
      const leader = new THREE.Line(
        leaderGeo,
        new THREE.LineBasicMaterial({
          color: leaderColor,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
        }),
      );
      leader.visible = false;

      group.add(core);
      group.add(corona);
      group.add(halo);
      group.add(spike);
      group.add(leader);
      root.add(group);

      const runtime: StarRuntime = {
        name: tag.name,
        group,
        core,
        corona,
        halo,
        spike,
        label: null,
        leader,
        basePos: positions[i].clone(),
        baseScale,
        phase: (hashSeed(tag.name) % 360) * (Math.PI / 180),
        color,
        count: tag.count,
        visual: 'idle',
        lastDim: 1,
      };
      if (topNames.has(tag.name) || selectedRef.current === tag.name) {
        attachLabel(runtime, selectedRef.current === tag.name);
      }
      setStarVisual(runtime, 'idle', 1, theme.mode);
      runtimes.push(runtime);
    });
    starsRef.current = runtimes;

    const ensureLabelVisible = (name: string | null) => {
      if (!name) return;
      const s = runtimes.find((x) => x.name === name);
      if (!s) return;
      attachLabel(s, selectedRef.current === name);
    };

    // 星座连线：全部候选（底色暗线）+ 选中时的共现高亮
    let baseLinks: THREE.LineSegments | null = null;
    let focusLinks: THREE.LineSegments | null = null;
    const pairs = quality.animateIdle ? buildLinkPairs(tags, positions) : [];
    if (quality.animateIdle && pairs.length) {
      const pos: number[] = [];
      for (const [i, j] of pairs) {
        pos.push(
          positions[i].x, positions[i].y, positions[i].z,
          positions[j].x, positions[j].y, positions[j].z,
        );
      }
      const baseGeo = new THREE.BufferGeometry();
      baseGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const baseMat = new THREE.LineBasicMaterial({
        color: theme.mode === 'light' ? 0x9db3cc : 0x7d93b8,
        transparent: true,
        opacity: theme.linkOpacity,
        blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
      });
      baseLinks = new THREE.LineSegments(baseGeo, baseMat);
      root.add(baseLinks);

      const focusMat = new THREE.LineBasicMaterial({
        color: theme.mode === 'light' ? 0x2f6ae0 : 0x9ec6ff,
        transparent: true,
        opacity: theme.linkFocus,
        blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
      });
      focusLinks = new THREE.LineSegments(new THREE.BufferGeometry(), focusMat);
      focusLinks.visible = false;
      root.add(focusLinks);
    }

    const rebuildFocus = (name: string | null) => {
      if (!focusLinks) return;
      const idx = name ? tags.findIndex((t) => t.name === name) : -1;
      if (idx < 0) {
        focusLinks.visible = false;
        return;
      }
      const pos: number[] = [];
      for (const [i, j] of pairs) {
        if (i === idx || j === idx) {
          pos.push(
            positions[i].x, positions[i].y, positions[i].z,
            positions[j].x, positions[j].y, positions[j].z,
          );
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      focusLinks.geometry.dispose();
      focusLinks.geometry = geo;
      focusLinks.visible = pos.length > 0;
    };
    apiRef.current = { rebuildFocus };
    rebuildFocus(selectedRef.current ?? null);

    // 细选中环 + 四向刻度
    const selectGroup = new THREE.Group();
    selectGroup.visible = false;
    scene.add(selectGroup);

    const ringMat = new THREE.MeshBasicMaterial({
      color: theme.selectRing,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    const ringInner = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.86, 48), ringMat);
    selectGroup.add(ringInner);

    const tickGeo = new THREE.PlaneGeometry(0.035, 0.16);
    const tickMat = new THREE.MeshBasicMaterial({
      color: theme.selectTick,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: theme.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const ticks: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i += 1) {
      const tick = new THREE.Mesh(tickGeo, tickMat);
      const a = (i / 4) * Math.PI * 2;
      tick.position.set(Math.cos(a) * 0.83, Math.sin(a) * 0.83, 0);
      tick.rotation.z = a + Math.PI / 2;
      selectGroup.add(tick);
      ticks.push(tick);
    }

    const ndc = new THREE.Vector3();
    const world = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const desired = new THREE.Vector3();
    const camOffset = new THREE.Vector3();
    let pointerDown: { x: number; y: number } | null = null;

    let resizeRaf = 0;
    let wakeRef: ((holdMs?: number) => void) | null = null;
    const setSize = () => {
      if (disposed) return;
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      labelRenderer.setSize(w, h);
      wakeRef?.(0);
    };
    setSize();
    const ro = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        setSize();
      });
    });
    ro.observe(wrap);

    const pickName = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      root.updateMatrixWorld(true);

      let bestName: string | null = null;
      let bestScore = Infinity;
      for (const s of runtimes) {
        s.group.getWorldPosition(world);
        ndc.copy(world).project(camera);
        if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 1.25 || Math.abs(ndc.y) > 1.25) continue;
        const sx = (ndc.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-ndc.y * 0.5 + 0.5) * rect.height + rect.top;
        const pixelDist = Math.hypot(clientX - sx, clientY - sy);
        const depthScale = 1.12 - Math.min(0.4, Math.max(0, ndc.z) * 0.35);
        const hitRadius = (34 + s.baseScale * 48) * depthScale;
        if (pixelDist > hitRadius) continue;
        const score = pixelDist + (ndc.z + 1) * 18;
        if (score < bestScore) {
          bestScore = score;
          bestName = s.name;
        }
      }
      return bestName;
    };

    const applyHover = (name: string | null) => {
      if (name === hoverRef.current) return;
      hoverRef.current = name;
      renderer.domElement.style.cursor = name ? 'pointer' : 'grab';
      for (const s of runtimes) {
        if (s.label) s.label.element.classList.toggle('is-hover', s.name === name);
      }
      ensureLabelVisible(name);
      wakeRef?.(200);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (performance.now() < ignoreCanvasPickUntil) return;
      pointerDown = { x: e.clientX, y: e.clientY };
      controls.autoRotate = false;
      wake(300);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (performance.now() < ignoreCanvasPickUntil) {
        pointerDown = null;
        return;
      }
      if (!pointerDown) return;
      const dx = e.clientX - pointerDown.x;
      const dy = e.clientY - pointerDown.y;
      pointerDown = null;
      if (Math.hypot(dx, dy) < 8) {
        const name = pickName(e.clientX, e.clientY);
        if (!name) onSelectRef.current(null);
        else {
          ensureLabelVisible(name);
          onSelectRef.current(selectedRef.current === name ? null : name);
        }
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (performance.now() < ignoreCanvasPickUntil) return;
      if (pointerDown) return;
      applyHover(pickName(e.clientX, e.clientY));
    };
    const onPointerLeave = () => {
      pointerDown = null;
      applyHover(null);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    let raf = 0;
    let frame = 0;
    let readyNotified = false;
    const clockStart = performance.now();
    const frameInterval = quality.animateIdle ? 1000 / 36 : 1000 / 30;
    let lastDraw = 0;
    let animUntil = 0;
    let interacting = false;
    let dirty = true;
    let running = false;

    const wake = (holdMs = 0) => {
      dirty = true;
      if (holdMs > 0) animUntil = Math.max(animUntil, performance.now() + holdMs);
      if (!running && !disposed && !document.hidden) {
        running = true;
        raf = requestAnimationFrame(tick);
      }
    };
    wakeRef = wake;

    controls.addEventListener('start', () => {
      interacting = true;
      wake(0);
    });
    controls.addEventListener('change', () => wake(0));
    controls.addEventListener('end', () => {
      interacting = false;
      wake(900);
    });

    const tick = (now: number) => {
      if (disposed || document.hidden) {
        running = false;
        raf = 0;
        return;
      }

      const hasSelection = Boolean(selectedRef.current);
      const hasHover = Boolean(hoverRef.current);
      const keepGoing =
        dirty || interacting || hasSelection || hasHover || now < animUntil;

      if (!keepGoing) {
        running = false;
        raf = 0;
        return;
      }

      if (now - lastDraw < frameInterval - 0.5) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastDraw = now;
      dirty = false;
      frame += 1;
      const t = (now - clockStart) / 1000;
      const heavyFrame = frame % 3 === 0;

      controls.update();
      if (quality.twinkle) {
        shaderUniforms.uTime.value = t;
      }

      if (interacting && heavyFrame) {
        farPoints.rotation.y = t * 0.002;
        milkyPoints.rotation.y = t * 0.0015;
      }

      const selectedName = selectedRef.current;
      const hoverName = hoverRef.current;
      let activeStar: StarRuntime | null = null;

      const updateStars = hasSelection || hasHover || heavyFrame || frame <= 2;
      if (updateStars) {
        for (const s of runtimes) {
          const active = Boolean(selectedName && s.name === selectedName);
          const hover = !active && hoverName === s.name;
          if (active) activeStar = s;

          if (active || hover) {
            const floatY = Math.sin(t * 0.9 + s.phase) * (active ? 0.06 : 0.03);
            const floatX = Math.cos(t * 0.55 + s.phase) * (active ? 0.03 : 0.015);
            s.group.position.set(
              s.basePos.x + floatX,
              s.basePos.y + floatY,
              s.basePos.z,
            );
            s.group.updateMatrix();
          } else if (
            s.group.position.x !== s.basePos.x ||
            s.group.position.y !== s.basePos.y
          ) {
            s.group.position.copy(s.basePos);
            s.group.updateMatrix();
          }

          const mode: 'idle' | 'hover' | 'active' = active ? 'active' : hover ? 'hover' : 'idle';
          const dim = selectedName && !active ? 0.72 : 1;
          setStarVisual(s, mode, dim, theme.mode);

          if (s.leader) {
            const shown = Boolean(s.label && s.label.visible && s.label.element.style.display !== 'none');
            const mat = s.leader.material as THREE.LineBasicMaterial;
            mat.opacity = shown ? 0.28 + 0.32 * dim : 0;
            s.leader.visible = shown;
          }

          if (active || hover || heavyFrame) {
            s.corona.quaternion.copy(camera.quaternion);
            s.halo.quaternion.copy(camera.quaternion);
            if (s.spike.visible) {
              s.spike.quaternion.copy(camera.quaternion);
              if (active) s.spike.rotation.z = t * 0.28 + s.phase;
            }
          }

          if (active) {
            const pulse = 1 + Math.sin(t * 1.2 + s.phase) * 0.022;
            s.halo.scale.setScalar(s.baseScale * 1.24 * 9.2 * pulse);
            s.corona.scale.setScalar(
              s.baseScale * 1.24 * 3.4 * (1 + Math.sin(t * 1.8 + s.phase) * 0.03),
            );
          }
        }
      } else if (selectedName) {
        activeStar = runtimes.find((s) => s.name === selectedName) || null;
      }

      if (frame % quality.labelSortEvery === 0) {
        root.updateMatrixWorld(true);
        for (const s of runtimes) {
          if (!s.label || !s.label.visible) continue;
          s.group.getWorldPosition(world);
          ndc.copy(world).project(camera);
          const z = Math.round((1 - (ndc.z + 1) * 0.5) * 1000);
          s.label.element.style.zIndex = String(100 + Math.max(0, Math.min(999, z)));
        }
      }

      if (activeStar) {
        ensureLabelVisible(activeStar.name);
        activeStar.group.getWorldPosition(tmp);
        selectGroup.visible = true;
        selectGroup.position.copy(tmp);
        selectGroup.quaternion.copy(camera.quaternion);
        const beat = 1 + Math.sin(t * 1.35) * 0.028;
        const sc = Math.max(0.5, activeStar.baseScale * 3.5) * beat;
        selectGroup.scale.setScalar(sc);
        ringMat.opacity = theme.mode === 'light' ? 0.7 : 0.48;
        tickMat.opacity = theme.mode === 'light' ? 0.72 : 0.55;
        selectGroup.rotation.z = t * 0.26;

        controls.target.lerp(tmp, 0.045);
        camOffset.copy(camera.position).sub(controls.target).normalize().multiplyScalar(9.5);
        desired.copy(tmp).add(camOffset);
        camera.position.lerp(desired, 0.03);
        controls.autoRotate = false;
        dirty = true;
      } else if (selectGroup.visible) {
        selectGroup.visible = false;
        ringMat.opacity = 0;
        tickMat.opacity = 0;
        controls.target.lerp(ZERO, 0.025);
        if (controls.target.distanceToSquared(ZERO) > 1e-4) dirty = true;
      }

      if (baseLinks && frame % 12 === 0) {
        (baseLinks.material as THREE.LineBasicMaterial).opacity = theme.linkOpacity;
      }

      renderer.render(scene, camera);
      if (activeStar || hoverName || frame % 3 === 0) {
        labelRenderer.render(scene, camera);
      }

      if (!readyNotified) {
        readyNotified = true;
        queueMicrotask(() => {
          if (!disposed) onReadyRef.current?.();
        });
      }

      if (
        dirty ||
        interacting ||
        selectedRef.current ||
        hoverRef.current ||
        performance.now() < animUntil
      ) {
        raf = requestAnimationFrame(tick);
      } else {
        running = false;
        raf = 0;
      }
    };

    // 首屏绘制
    wake(0);

    const onVisibility = () => {
      if (!document.hidden && !disposed) {
        wake(200);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      apiRef.current = null;
      starsRef.current = [];
      scene.traverse((obj) => {
        if (
          obj instanceof THREE.Mesh ||
          obj instanceof THREE.Points ||
          obj instanceof THREE.LineSegments ||
          obj instanceof THREE.LineLoop ||
          obj instanceof THREE.Line
        ) {
          obj.geometry?.dispose?.();
          const m = obj.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose?.();
        }
      });
      dustTex.dispose();
      dustSoftTex?.dispose();
      glowTex.dispose();
      coronaTex.dispose();
      spikeTex.dispose();
      band.texture.dispose();
      bgTex.dispose();
      coreGeo.dispose();
      planeGeo.dispose();
      tickGeo.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === wrap) wrap.removeChild(renderer.domElement);
      if (labelRenderer.domElement.parentElement === wrap) wrap.removeChild(labelRenderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagKey, themeMode]);

  return (
    <div
      ref={wrapRef}
      className={['tu-stage', `is-${themeMode}`, selected ? 'has-selection' : '', className].filter(Boolean).join(' ')}
      data-universe-theme={themeMode}
    >
      <div className="tu-vignette" aria-hidden />
    </div>
  );
}
