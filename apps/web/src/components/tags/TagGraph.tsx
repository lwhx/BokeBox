import { useEffect, useMemo, useRef, useState } from 'react';
import { hashSeed } from '../../lib/format';
import type { TagStar } from './types';

type Props = {
  tags: TagStar[];
  selected?: string | null;
  onSelect: (name: string | null) => void;
  onReady?: () => void;
  ariaLabel?: string;
  className?: string;
};

type GraphNode = {
  tag: TagStar;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hue: number;
};

type GraphEdge = {
  a: number;
  b: number;
  weight: number;
};

type GraphTheme = {
  background: string;
  grid: string;
  edge: string;
  edgeActive: string;
  node: string[];
  nodeText: string;
  nodeMuted: string;
  selected: string;
};

const WORLD = { width: 1800, height: 1200 };
const PALETTE = ['#75a3f2', '#73b9b0', '#9498df', '#d5a66b'];

function graphTheme(light: boolean): GraphTheme {
  return light
    ? {
        background: '#f3f6fb',
        grid: 'rgba(50, 77, 117, 0.08)',
        edge: 'rgba(72, 101, 145, 0.22)',
        edgeActive: 'rgba(45, 105, 224, 0.82)',
        node: PALETTE.map((color) => color),
        nodeText: '#17243a',
        nodeMuted: '#71829c',
        selected: '#2868dc',
      }
    : {
        background: '#0b1020',
        grid: 'rgba(153, 179, 224, 0.08)',
        edge: 'rgba(148, 173, 218, 0.25)',
        edgeActive: 'rgba(124, 174, 255, 0.95)',
        node: PALETTE.map((color) => color),
        nodeText: '#edf3ff',
        nodeMuted: '#8393b0',
        selected: '#8bb8ff',
      };
}

function buildEdges(tags: TagStar[]): GraphEdge[] {
  const candidates: GraphEdge[] = [];
  for (let i = 0; i < tags.length; i += 1) {
    const left = new Set(tags[i].items.map((item) => item.job.id));
    for (let j = i + 1; j < tags.length; j += 1) {
      let shared = 0;
      for (const item of tags[j].items) {
        if (left.has(item.job.id)) shared += 1;
      }
      if (shared > 0) candidates.push({ a: i, b: j, weight: shared });
    }
  }
  // 默认图谱只保留每个节点最强的 4 条关系，避免高频标签把画布变成毛线团。
  const keep = new Set<number>();
  for (let i = 0; i < tags.length; i += 1) {
    candidates
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => edge.a === i || edge.b === i)
      .sort((a, b) => b.edge.weight - a.edge.weight)
      .slice(0, 4)
      .forEach(({ index }) => keep.add(index));
  }
  return candidates.filter((_, index) => keep.has(index));
}

function makeNodes(tags: TagStar[], edges: GraphEdge[]): GraphNode[] {
  const maxCount = Math.max(1, ...tags.map((tag) => tag.count));
  const nodes = tags.map((tag, index) => {
    const seed = hashSeed(tag.name);
    const columns = Math.max(4, Math.ceil(Math.sqrt(tags.length * 1.45)));
    const rows = Math.max(1, Math.ceil(tags.length / columns));
    const column = index % columns;
    const row = Math.floor(index / columns);
    const jitterX = ((seed % 31) - 15) * 2;
    const jitterY = (((seed >> 5) % 31) - 15) * 2;
    return {
      tag,
      x: 180 + (column / Math.max(1, columns - 1)) * (WORLD.width - 360) + jitterX,
      y: 150 + (row / Math.max(1, rows - 1)) * (WORLD.height - 300) + jitterY,
      vx: 0,
      vy: 0,
      radius: 5 + Math.sqrt(tag.count / maxCount) * 10,
      hue: seed % 360,
    };
  });

  const ideal = Math.sqrt((WORLD.width * WORLD.height) / Math.max(nodes.length, 1)) * 1.08;
  for (let iteration = 0; iteration < 150; iteration += 1) {
    const cooling = iteration < 90 ? 0.08 : 0.045;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = (ideal * ideal) / (distance * distance) * 1.15;
        dx /= distance;
        dy /= distance;
        a.vx += dx * force;
        a.vy += dy * force;
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
    }
    for (const edge of edges) {
      const a = nodes[edge.a];
      const b = nodes[edge.b];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const distance = Math.max(0.001, Math.hypot(dx, dy));
      const force = (distance - ideal * (1.16 - Math.min(edge.weight, 4) * 0.06)) * 0.006;
      dx /= distance;
      dy /= distance;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
    for (const node of nodes) {
      node.vx -= (node.x - WORLD.width / 2) * 0.00055;
      node.vy -= (node.y - WORLD.height / 2) * 0.00055;
      node.vx *= 1 - cooling;
      node.vy *= 1 - cooling;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > 18) {
        node.vx *= 18 / speed;
        node.vy *= 18 / speed;
      }
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const scale = Math.min(
    (WORLD.width - 260) / Math.max(1, maxX - minX),
    (WORLD.height - 260) / Math.max(1, maxY - minY),
    1.25,
  );
  for (const node of nodes) {
    node.x = (node.x - (minX + maxX) / 2) * scale + WORLD.width / 2;
    node.y = (node.y - (minY + maxY) / 2) * scale + WORLD.height / 2;
  }
  return nodes;
}

export function TagGraph({ tags, selected, onSelect, onReady, ariaLabel, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onSelectRef = useRef(onSelect);
  const onReadyRef = useRef(onReady);
  const selectedRef = useRef(selected);
  const wakeRef = useRef<(() => void) | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );

  const tagKey = useMemo(() => tags.map((tag) => `${tag.name}:${tag.count}`).join('|'), [tags]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    selectedRef.current = selected;
    wakeRef.current?.();
  }, [selected]);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!wrap || !canvas || !context) return;

    const edges = buildEdges(tags);
    const nodes = makeNodes(tags, edges);
    const topLabels = new Set(
      [...tags]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
        .slice(0, 16)
        .map((tag) => tag.name),
    );
    const palette = graphTheme(theme === 'light');
    const view = { x: 0, y: 0, scale: 1 };
    let width = 1;
    let height = 1;
    let dpr = 1;
    let hovered: GraphNode | null = null;
    let drag: { x: number; y: number; viewX: number; viewY: number; moved: boolean } | null = null;
    let raf = 0;
    let running = false;
    let disposed = false;

    const fitView = () => {
      view.scale = Math.min(1.12, Math.max(0.34, Math.min((width - 80) / WORLD.width, (height - 80) / WORLD.height)));
      view.x = (width - WORLD.width * view.scale) / 2;
      view.y = (height - WORLD.height * view.scale) / 2;
    };

    const resize = () => {
      width = wrap.clientWidth || 1;
      height = wrap.clientHeight || 1;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      fitView();
      wake();
    };

    const worldPoint = (clientX: number, clientY: number) => ({
      x: (clientX - view.x) / view.scale,
      y: (clientY - view.y) / view.scale,
    });

    const nodeAt = (clientX: number, clientY: number) => {
      const point = worldPoint(clientX, clientY);
      let match: GraphNode | null = null;
      let closest = Infinity;
      for (const node of nodes) {
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance * view.scale <= Math.max(15, node.radius * view.scale + 7) && distance < closest) {
          match = node;
          closest = distance;
        }
      }
      return match;
    };

    const draw = () => {
      running = false;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const background = context.createRadialGradient(width * 0.52, height * 0.44, 0, width * 0.52, height * 0.44, Math.max(width, height) * 0.78);
      background.addColorStop(0, theme === 'light' ? '#fbfcfe' : '#121a30');
      background.addColorStop(1, palette.background);
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
      context.save();
      context.translate(view.x, view.y);
      context.scale(view.scale, view.scale);

      context.strokeStyle = palette.grid;
      context.lineWidth = 1 / view.scale;
      for (let x = 0; x <= WORLD.width; x += 160) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, WORLD.height);
        context.stroke();
      }
      for (let y = 0; y <= WORLD.height; y += 160) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(WORLD.width, y);
        context.stroke();
      }

      const selectedNode = selectedRef.current
        ? nodes.find((node) => node.tag.name === selectedRef.current) || null
        : null;
      const connected = new Set<number>();
      if (selectedNode) {
        nodes.forEach((node, index) => {
          if (node === selectedNode) connected.add(index);
        });
        edges.forEach((edge) => {
          if (edge.a === nodes.indexOf(selectedNode)) connected.add(edge.b);
          if (edge.b === nodes.indexOf(selectedNode)) connected.add(edge.a);
        });
      }

      for (const edge of edges) {
        const active = Boolean(selectedNode && (nodes[edge.a] === selectedNode || nodes[edge.b] === selectedNode));
        const muted = Boolean(selectedNode && !active);
        context.strokeStyle = active ? palette.edgeActive : palette.edge;
        context.globalAlpha = muted ? 0.08 : active ? 0.92 : 0.34;
        context.lineWidth = (0.75 + Math.min(edge.weight, 4) * 0.28 + (active ? 0.85 : 0)) / view.scale;
        context.beginPath();
        context.moveTo(nodes[edge.a].x, nodes[edge.a].y);
        context.lineTo(nodes[edge.b].x, nodes[edge.b].y);
        context.stroke();
      }
      context.globalAlpha = 1;

      nodes.forEach((node, index) => {
        const isSelected = node === selectedNode;
        const isConnected = connected.has(index);
        const isHovered = node === hovered;
        const muted = Boolean(selectedNode && !isSelected && !isConnected);
        const color = palette.node[node.hue % palette.node.length];
        const radius = node.radius + (isHovered || isSelected ? 3 : 0);
        context.globalAlpha = muted ? 0.24 : 1;
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fillStyle = color;
        context.shadowColor = color;
        context.shadowBlur = isSelected || isHovered ? 12 : 0;
        context.fill();
        context.shadowBlur = 0;
        if (isSelected) {
          context.strokeStyle = palette.selected;
          context.lineWidth = 2.2 / view.scale;
          context.beginPath();
          context.arc(node.x, node.y, radius + 7, 0, Math.PI * 2);
          context.stroke();
        }

        if (topLabels.has(node.tag.name) || isSelected || isHovered) {
          const label = `${node.tag.name}  ${node.tag.count}`;
          context.font = `${isSelected || isHovered ? 700 : 600} 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
          context.textBaseline = 'middle';
          const labelWidth = context.measureText(label).width;
          const labelX = node.x + radius + 7;
          const labelY = node.y;
          context.fillStyle = theme === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(11,16,31,0.9)';
          context.fillRect(labelX - 4, labelY - 9, labelWidth + 8, 18);
          context.fillStyle = muted ? palette.nodeMuted : palette.nodeText;
          context.fillText(label, labelX, labelY);
        }
        context.globalAlpha = 1;
      });
      context.restore();
    };

    function wake() {
      if (!running && !disposed) {
        running = true;
        raf = window.requestAnimationFrame(draw);
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y, moved: false };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const handlePointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (drag) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.moved ||= Math.hypot(dx, dy) > 5;
        view.x = drag.viewX + dx;
        view.y = drag.viewY + dy;
        hovered = null;
      } else {
        const next = nodeAt(x, y);
        hovered = next;
        canvas.style.cursor = next ? 'pointer' : 'grab';
      }
      wake();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (drag && !drag.moved) {
        const rect = canvas.getBoundingClientRect();
        const hit = nodeAt(event.clientX - rect.left, event.clientY - rect.top);
        onSelectRef.current(hit && selectedRef.current === hit.tag.name ? null : hit?.tag.name || null);
      }
      drag = null;
      canvas.style.cursor = hovered ? 'pointer' : 'grab';
      wake();
    };
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const before = { x: (mouseX - view.x) / view.scale, y: (mouseY - view.y) / view.scale };
      const nextScale = Math.min(2.2, Math.max(0.34, view.scale * (event.deltaY < 0 ? 1.1 : 0.9)));
      view.scale = nextScale;
      view.x = mouseX - before.x * nextScale;
      view.y = mouseY - before.y * nextScale;
      wake();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    wakeRef.current = wake;
    resize();
    onReadyRef.current?.();

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
      wakeRef.current = null;
      observer.disconnect();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('wheel', handleWheel);
    };
    // selectedRef avoids rebuilding the graph every time a node is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagKey, theme]);

  return (
    <div
      ref={wrapRef}
      className={['tg-stage', `is-${theme}`, className].filter(Boolean).join(' ')}
      role="img"
      aria-label={ariaLabel}
    >
      <canvas ref={canvasRef} className="tg-canvas" aria-hidden="true" />
    </div>
  );
}
