"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type CoreState = "idle" | "listening" | "thinking";
type ViewMode = "core" | "map";

type KnowledgeNode = {
  id: string;
  label: string;
  group: string;
  kind: "system" | "page" | "data_source";
  x: number;
  y: number;
  size: number;
  url?: string;
  icon?: string;
  content?: string;
  lastEdited?: string;
  keywords?: string[];
};

type KnowledgeEdge = {
  source: string;
  target: string;
  type: "root" | "parent" | "relation" | "mention" | "child" | "similarity";
  weight?: number;
  reason?: string;
};

type NotionStatus = {
  configured: boolean;
  connected: boolean;
  botName?: string;
  workspaceName?: string | null;
  error?: string;
};

type GraphPayload = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  syncedAt: string;
  pageCount: number;
  dataSourceCount: number;
  contentScannedCount: number;
  similarityEdgeCount: number;
  clusterCount: number;
};

type BriefingItem = {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: "techpresso" | "github" | "openai" | "hackernews";
  sourceLabel: string;
  publishedAt: string;
  score: number;
  priority: "important" | "worth_knowing";
  topics: string[];
  matchedTopics: string[];
};

type DailyBriefing = {
  date: string;
  generatedAt: string;
  items: BriefingItem[];
  sourceStatus: Array<{ source: string; label: string; ok: boolean; count: number; error?: string }>;
  glossary?: {
    term: string;
    definition: string;
    example: string;
    whyItMatters: string;
    sourceItemId: string;
  };
};

type WeatherPayload = {
  location: string;
  updatedAt: string;
  current: {
    temperature: number;
    apparentTemperature: number;
    weatherCode: number;
    label: string;
    symbol: string;
    windSpeed: number;
  };
  today: { max: number; min: number; rainChance: number };
  forecast: Array<{
    date: string;
    weatherCode: number;
    label: string;
    symbol: string;
    max: number;
    min: number;
    rainChance: number;
  }>;
  attribution: { label: string; url: string };
};

const BRIEFING_CACHE_KEY = "jarvis-briefing-cache-v1";
const BRIEFING_HIDDEN_KEY = "jarvis-briefing-hidden-v1";
const BRIEFING_SAVED_KEY = "jarvis-briefing-saved-v1";

function formatBriefingAge(date: string) {
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 3_600_000));
  if (hours < 1) return "GERADE EBEN";
  if (hours < 24) return `VOR ${hours}H`;
  const days = Math.floor(hours / 24);
  return `VOR ${days}T`;
}

const demoKnowledgeNodes: KnowledgeNode[] = [
  { id: "jarvis", label: "JARVIS", group: "System", kind: "system", x: 0, y: 0, size: 7 },
  { id: "uni", label: "Universität", group: "Universität", kind: "page", x: -0.31, y: -0.2, size: 6 },
  { id: "economics", label: "Wirtschaft", group: "Universität", kind: "page", x: -0.44, y: 0.1, size: 4 },
  { id: "statistics", label: "Statistik", group: "Universität", kind: "page", x: -0.24, y: 0.26, size: 4 },
  { id: "projects", label: "Projekte", group: "Projekte", kind: "page", x: 0.31, y: -0.24, size: 6 },
  { id: "notion", label: "Notion", group: "Projekte", kind: "page", x: 0.45, y: 0.02, size: 4 },
  { id: "ideas", label: "Ideen", group: "Ideen", kind: "page", x: 0.27, y: 0.27, size: 5 },
  { id: "learning", label: "Lernsystem", group: "Ideen", kind: "page", x: -0.04, y: 0.36, size: 4 },
  { id: "productivity", label: "Produktivität", group: "Ideen", kind: "page", x: 0.08, y: -0.37, size: 5 },
];

const demoGraphEdges: KnowledgeEdge[] = [
  { source: "jarvis", target: "uni", type: "root" },
  { source: "jarvis", target: "projects", type: "root" },
  { source: "jarvis", target: "ideas", type: "root" },
  { source: "jarvis", target: "productivity", type: "root" },
  { source: "uni", target: "economics", type: "parent" },
  { source: "uni", target: "statistics", type: "parent" },
  { source: "statistics", target: "learning", type: "mention" },
  { source: "projects", target: "notion", type: "parent" },
  { source: "notion", target: "ideas", type: "relation" },
  { source: "ideas", target: "learning", type: "relation" },
  { source: "learning", target: "productivity", type: "mention" },
  { source: "notion", target: "productivity", type: "relation" },
];

function NeuralCanvas({ state, mode, nodes, edges, selectedNodeId, onSelect }: {
  state: CoreState;
  mode: ViewMode;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  selectedNodeId: string;
  onSelect: (node: KnowledgeNode) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: 0, y: 0, active: false });
  const rotationRef = useRef({
    targetX: 0,
    targetY: 0,
    currentX: 0,
    currentY: 0,
    velocityX: 0,
    velocityY: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
  });
  const coreBoundsRef = useRef({ x: 0, y: 0, radius: 0 });
  const mapPointsRef = useRef<Array<{ node: KnowledgeNode; x: number; y: number }>>([]);
  const hoveredNodeRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let backingWidth = 0;
    let backingHeight = 0;
    let time = 0;
    let hoverX = 0;
    let hoverY = 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const particleCount = window.innerWidth < 720 ? 190 : 320;
    const particles = Array.from({ length: particleCount }, () => {
      return {
        u: Math.random() * Math.PI * 2,
        v: Math.asin(Math.random() * 2 - 1),
        phase: Math.random() * Math.PI * 2,
        speedU: 0.45 + Math.random() * 0.85,
        speedV: (Math.random() - 0.5) * 0.55,
        drift: 0.65 + Math.random() * 1.9,
        bright: Math.random() > 0.9,
        trail: [] as Array<{ x: number; y: number }>,
      };
    });
    const filaments = Array.from({ length: window.innerWidth < 720 ? 24 : 42 }, () => ({
      u: Math.random() * Math.PI * 2,
      v: Math.asin(Math.random() * 2 - 1),
      phase: Math.random() * Math.PI * 2,
      speed: 0.2 + Math.random() * 0.42,
      span: 0.7 + Math.random() * 1.5,
      alpha: 0.035 + Math.random() * 0.09,
    }));

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const nextWidth = Math.floor(width * dpr);
      const nextHeight = Math.floor(height * dpr);
      if (backingWidth === nextWidth && backingHeight === nextHeight) return;
      backingWidth = nextWidth;
      backingHeight = nextHeight;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles.forEach((particle) => { particle.trail.length = 0; });
    };

    const drawCore = () => {
      const cx = width / 2;
      const cy = height / 2 - Math.min(12, height * 0.02);
      const baseRadius = Math.min(width, height) * (width < 720 ? 0.34 : 0.37);
      const statePulse = state === "listening" ? 1.07 : state === "thinking" ? 0.95 : 1;
      const pulse = statePulse + Math.sin(time * (state === "thinking" ? 3.2 : 1.2)) * 0.018;
      coreBoundsRef.current = { x: cx, y: cy, radius: baseRadius * 1.02 * pulse };
      const projected: Array<{ x: number; y: number; z: number; a: number; bright: boolean; trail: Array<{ x: number; y: number }> }> = [];
      const flowSpeed = state === "thinking" ? 1.7 : state === "listening" ? 1.25 : 1;
      const rotation = rotationRef.current;
      if (!rotation.dragging) {
        rotation.targetY += rotation.velocityY;
        rotation.targetX = Math.max(-0.88, Math.min(0.88, rotation.targetX + rotation.velocityX));
        rotation.velocityX *= 0.92;
        rotation.velocityY *= 0.92;
      }
      rotation.currentX += (rotation.targetX - rotation.currentX) * 0.11;
      rotation.currentY += (rotation.targetY - rotation.currentY) * 0.11;
      hoverX += ((pointerRef.current.active ? pointerRef.current.x : 0) - hoverX) * 0.055;
      hoverY += ((pointerRef.current.active ? pointerRef.current.y : 0) - hoverY) * 0.055;
      const rotY = time * 0.16 * flowSpeed + rotation.currentY + hoverX * 0.24;
      const rotX = -0.16 + rotation.currentX + hoverY * 0.16;

      const projectFlowPoint = (u: number, v: number, phase: number) => {
        const longitude = u + Math.sin(v * 2.1 + time * 0.72 + phase) * 0.085;
        const movingLatitude = v
          + Math.sin(u * 2.7 - time * 0.38 + phase) * 0.11
          + Math.sin(time * 0.24 + phase) * 0.035;
        const latitude = Math.asin(Math.sin(movingLatitude));
        const radius = 0.88
          + Math.sin(longitude * 3 + phase + time * 0.34) * 0.045
          + Math.sin(latitude * 5 - time * 0.28 + phase) * 0.025;
        const latitudeRadius = Math.cos(latitude);
        let x = radius * latitudeRadius * Math.cos(longitude);
        let y = radius * Math.sin(latitude);
        const z = radius * latitudeRadius * Math.sin(longitude);

        x *= 1.015;
        y *= 0.985;

        const x1 = x * Math.cos(rotY) - z * Math.sin(rotY);
        const z1 = x * Math.sin(rotY) + z * Math.cos(rotY);
        const y1 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
        const z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
        const perspective = 0.92 + z2 * 0.105;
        return {
          x: cx + x1 * baseRadius * perspective * pulse,
          y: cy + y1 * baseRadius * perspective * pulse,
          z: z2,
          a: Math.max(0.06, 0.18 + (z2 + 0.5) * 0.46),
        };
      };

      for (const particle of particles) {
        const u = particle.u + time * particle.speedU * 0.22 * flowSpeed;
        const v = particle.v + time * particle.speedV * 0.075
          + Math.sin(time * particle.drift + particle.phase) * 0.075;
        const point = projectFlowPoint(u, v, particle.phase);
        particle.trail.push({ x: point.x, y: point.y });
        const maxTrail = particle.bright ? 18 : 7;
        if (particle.trail.length > maxTrail) particle.trail.shift();
        projected.push({ ...point, bright: particle.bright, trail: particle.trail });
      }

      context.globalCompositeOperation = "lighter";

      // Long, moving filaments create the fluid, hand-drawn neural silhouette.
      for (const filament of filaments) {
        context.strokeStyle = `rgba(255, 218, 236, ${filament.alpha})`;
        context.lineWidth = 0.42 + filament.alpha * 4;
        context.beginPath();
        for (let step = 0; step <= 34; step++) {
          const progress = step / 34;
          const u = filament.u + time * filament.speed * flowSpeed + progress * filament.span;
          const v = filament.v
            + progress * 0.32
            + Math.sin(progress * 8 + filament.phase + time * 0.8) * 0.24;
          const point = projectFlowPoint(u, v, filament.phase);
          if (step === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        }
        context.stroke();
      }

      // Short motion trails make each node visibly travel through the structure.
      for (const point of projected) {
        if (point.trail.length < 2) continue;
        context.strokeStyle = `rgba(255, 211, 232, ${point.bright ? 0.22 : 0.038})`;
        context.lineWidth = point.bright ? 0.75 : 0.32;
        context.beginPath();
        point.trail.forEach((trailPoint, index) => {
          if (index === 0) context.moveTo(trailPoint.x, trailPoint.y);
          else context.lineTo(trailPoint.x, trailPoint.y);
        });
        context.stroke();
      }

      // Connections are recalculated every frame, so the network never freezes.
      const linkDistance = baseRadius * 0.235;
      for (let i = 0; i < projected.length; i++) {
        const a = projected[i];
        let connections = 0;
        for (let offset = 1; offset <= 34 && connections < 4; offset++) {
          const b = projected[(i + offset * 17) % projected.length];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < linkDistance && Math.abs(a.z - b.z) < 0.42) {
            const opacity = Math.max(0, 1 - distance / linkDistance) * 0.19 * Math.min(a.a, b.a);
            context.strokeStyle = `rgba(255, 216, 235, ${opacity})`;
            context.lineWidth = 0.34 + opacity * 1.8;
            context.beginPath();
            context.moveTo(a.x, a.y);
            const bow = Math.sin(i * 1.7 + time * 1.7) * 4;
            context.quadraticCurveTo(
              (a.x + b.x) / 2 + bow,
              (a.y + b.y) / 2 - bow,
              b.x,
              b.y,
            );
            context.stroke();
            connections++;
          }
        }
      }

      for (const point of projected) {
        const pointRadius = point.bright ? 1.55 : 0.38 + point.a * 0.5;
        if (point.bright) {
          const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, 10);
          glow.addColorStop(0, "rgba(255,255,255,.95)");
          glow.addColorStop(0.18, "rgba(255,205,229,.58)");
          glow.addColorStop(1, "rgba(255,205,229,0)");
          context.fillStyle = glow;
          context.beginPath();
          context.arc(point.x, point.y, 10, 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = `rgba(255, 240, 247, ${Math.min(1, point.a + (point.bright ? .35 : 0))})`;
        context.beginPath();
        context.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
        context.fill();
      }

      context.globalCompositeOperation = "source-over";

      const halo = context.createRadialGradient(cx, cy, baseRadius * 0.1, cx, cy, baseRadius * 1.24);
      halo.addColorStop(0, "rgba(14, 7, 11, 0)");
      halo.addColorStop(0.67, state === "listening" ? "rgba(255,174,213,.065)" : "rgba(255,193,222,.035)");
      halo.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = halo;
      context.fillRect(0, 0, width, height);
    };

    const drawMap = () => {
      const cx = width / 2;
      const cy = height / 2 - 12;
      const scaleX = Math.min(width * 0.74, 1100);
      const scaleY = Math.min(height * 0.82, 700);
      const positions = nodes.map((node) => ({
        ...node,
        px: cx + node.x * scaleX,
        py: cy + node.y * scaleY,
      }));
      mapPointsRef.current = positions.map((node) => ({ node, x: node.px, y: node.py }));
      const positionById = new Map(positions.map((node) => [node.id, node]));
      const selected = positionById.get(selectedNodeId);
      const focusActive = Boolean(selected && selected.kind !== "system");
      const relatedIds = new Set<string>([selectedNodeId]);
      for (const edge of edges) {
        if (edge.source === selectedNodeId) relatedIds.add(edge.target);
        if (edge.target === selectedNodeId) relatedIds.add(edge.source);
      }

      for (const edge of edges) {
        const a = positionById.get(edge.source);
        const b = positionById.get(edge.target);
        if (!a || !b) continue;
        const directlySelected = edge.source === selectedNodeId || edge.target === selectedNodeId;
        const sameCluster = focusActive && a.group === selected?.group && b.group === selected?.group;
        const opacity = focusActive ? (directlySelected ? 0.82 : sameCluster ? 0.24 : 0.065) : 0.34;
        const strength = Math.max(0.2, edge.weight ?? 0.4);
        const gradient = context.createLinearGradient(a.px, a.py, b.px, b.py);
        gradient.addColorStop(0, `rgba(255,211,232,${opacity * 0.22})`);
        gradient.addColorStop(0.5, `rgba(255,222,238,${opacity * strength})`);
        gradient.addColorStop(1, `rgba(255,211,232,${opacity * 0.22})`);
        context.strokeStyle = gradient;
        context.lineWidth = directlySelected ? 1.45 : edge.type === "relation" ? 1.05 : 0.7;
        context.setLineDash(edge.type === "similarity" ? [2, 4] : []);
        context.beginPath();
        context.moveTo(a.px, a.py);
        context.quadraticCurveTo((a.px + b.px) / 2, (a.py + b.py) / 2 + Math.sin(time + a.x * 10) * 8, b.px, b.py);
        context.stroke();
      }
      context.setLineDash([]);

      positions.forEach((node, index) => {
        const isDirectlyRelated = relatedIds.has(node.id);
        const isSameCluster = focusActive && node.group === selected?.group;
        context.globalAlpha = !focusActive || isDirectlyRelated ? 1 : isSameCluster ? 0.62 : 0.24;
        const pulse = 1 + Math.sin(time * 1.4 + index) * 0.14;
        const isActive = node.id === selectedNodeId || node.id === hoveredNodeRef.current;
        const glowRadius = node.size * (isActive ? 6.2 : 4.1) * pulse;
        const glow = context.createRadialGradient(node.px, node.py, 0, node.px, node.py, glowRadius);
        glow.addColorStop(0, "rgba(255,248,251,.92)");
        glow.addColorStop(0.12, isActive ? "rgba(255,190,221,.76)" : "rgba(255,190,221,.42)");
        glow.addColorStop(1, "rgba(242,143,190,0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(node.px, node.py, glowRadius, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "rgba(255,243,249,.96)";
        context.beginPath();
        context.arc(node.px, node.py, node.size * 0.5, 0, Math.PI * 2);
        context.fill();
      });
      context.globalAlpha = 1;

      const labelBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      const labelCandidates = positions
        .filter((node) => {
          const isActive = node.id === selectedNodeId || node.id === hoveredNodeRef.current;
          if (isActive || node.kind === "system") return true;
          if (focusActive) return (relatedIds.has(node.id) || node.group === selected?.group) && node.size >= 3.7;
          return node.size >= 4.55;
        })
        .sort((a, b) => {
          const aPriority = a.id === selectedNodeId ? 100 : a.id === hoveredNodeRef.current ? 90 : a.kind === "system" ? 80 : a.size;
          const bPriority = b.id === selectedNodeId ? 100 : b.id === hoveredNodeRef.current ? 90 : b.kind === "system" ? 80 : b.size;
          return bPriority - aPriority;
        });

      for (const node of labelCandidates) {
        const isActive = node.id === selectedNodeId || node.id === hoveredNodeRef.current;
        const fontSize = isActive || node.kind === "system" ? 12 : 10;
        context.font = `${fontSize}px var(--font-geist-mono), monospace`;
        context.letterSpacing = ".3px";
        const label = node.label.slice(0, 48);
        const labelWidth = context.measureText(label).width + 10;
        const labelY = node.py + node.size * 2.6 + 12;
        const box = {
          left: node.px - labelWidth / 2,
          right: node.px + labelWidth / 2,
          top: labelY - fontSize,
          bottom: labelY + 4,
        };
        const collides = labelBoxes.some((other) => !(box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom));
        if (collides && !isActive) continue;
        labelBoxes.push(box);
        context.fillStyle = isActive ? "rgba(255,247,251,.98)" : node.kind === "system" ? "rgba(255,228,241,.9)" : "rgba(215,190,202,.78)";
        context.textAlign = "center";
        context.fillText(label, node.px, labelY);
      }
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      const vignette = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      vignette.addColorStop(0, "rgba(14,8,11,.08)");
      vignette.addColorStop(1, "rgba(0,0,0,.44)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);
      if (mode === "core") drawCore(); else drawMap();
      if (!reduceMotion) time += 0.012;
      animationFrame = requestAnimationFrame(draw);
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", resize);
    draw();
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [state, mode, nodes, edges, selectedNodeId]);

  const isInsideCore = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const bounds = coreBoundsRef.current;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return bounds.radius > 0 && Math.hypot(x - bounds.x, y - bounds.y) <= bounds.radius;
  };

  const updatePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (mode === "core") {
      const rotation = rotationRef.current;
      const insideCore = isInsideCore(event);
      pointerRef.current = {
        x: (localX / rect.width - 0.5) * 2,
        y: (localY / rect.height - 0.5) * 2,
        active: insideCore && !rotation.dragging,
      };
      if (rotation.dragging) {
        const deltaX = event.clientX - rotation.lastX;
        const deltaY = event.clientY - rotation.lastY;
        rotation.targetY += deltaX * 0.009;
        rotation.targetX = Math.max(-0.88, Math.min(0.88, rotation.targetX + deltaY * 0.009));
        rotation.velocityY = deltaX * 0.00075;
        rotation.velocityX = deltaY * 0.00075;
        rotation.lastX = event.clientX;
        rotation.lastY = event.clientY;
      }
      event.currentTarget.style.cursor = rotation.dragging ? "grabbing" : insideCore ? "grab" : "default";
      return;
    }
    pointerRef.current = {
      x: (localX / rect.width - 0.5) * 2,
      y: (localY / rect.height - 0.5) * 2,
      active: true,
    };
    if (mode === "map") {
      const closest = mapPointsRef.current
        .map((point) => ({ point, distance: Math.hypot(point.x - localX, point.y - localY) }))
        .sort((a, b) => a.distance - b.distance)[0];
      hoveredNodeRef.current = closest && closest.distance < 24 ? closest.point.node.id : null;
      event.currentTarget.style.cursor = hoveredNodeRef.current ? "pointer" : "crosshair";
    }
  };

  const selectMapNode = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "map") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const closest = mapPointsRef.current
      .map((point) => ({ ...point, distance: Math.hypot(point.x - x, point.y - y) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (closest && closest.distance < 36) onSelect(closest.node);
  };

  const startCanvasInteraction = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "map") {
      selectMapNode(event);
      return;
    }
    if (!isInsideCore(event)) {
      pointerRef.current.active = false;
      event.currentTarget.style.cursor = "default";
      return;
    }
    const rotation = rotationRef.current;
    rotation.dragging = true;
    rotation.lastX = event.clientX;
    rotation.lastY = event.clientY;
    rotation.velocityX = 0;
    rotation.velocityY = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.cursor = "grabbing";
  };

  const endCanvasInteraction = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "core") return;
    rotationRef.current.dragging = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.style.cursor = isInsideCore(event) ? "grab" : "default";
  };

  return (
    <canvas
      ref={canvasRef}
      className={`neural-canvas mode-${mode}`}
      aria-label={mode === "core" ? "Animierter neuronaler Jarvis-Kern" : "Interaktiver Wissensgraph"}
      onPointerMove={updatePointer}
      onPointerLeave={(event) => {
        pointerRef.current.active = false;
        hoveredNodeRef.current = null;
        event.currentTarget.style.cursor = mode === "core"
          ? rotationRef.current.dragging ? "grabbing" : "default"
          : "crosshair";
      }}
      onPointerDown={startCanvasInteraction}
      onPointerUp={endCanvasInteraction}
      onPointerCancel={endCanvasInteraction}
    />
  );
}

export default function Home() {
  const [state, setState] = useState<CoreState>("idle");
  const [mode, setMode] = useState<ViewMode>("core");
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [nodes, setNodes] = useState<KnowledgeNode[]>(demoKnowledgeNodes);
  const [edges, setEdges] = useState<KnowledgeEdge[]>(demoGraphEdges);
  const [selectedNode, setSelectedNode] = useState<KnowledgeNode>(demoKnowledgeNodes[0]);
  const [notionStatus, setNotionStatus] = useState<NotionStatus>({ configured: false, connected: false });
  const [graphMeta, setGraphMeta] = useState<Omit<GraphPayload, "nodes" | "edges"> | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notionError, setNotionError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(true);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherPayload | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [hiddenBriefingIds, setHiddenBriefingIds] = useState<string[]>([]);
  const [savedBriefingIds, setSavedBriefingIds] = useState<string[]>([]);
  const [footerDate, setFooterDate] = useState("—");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNotion = useCallback(async (force = false) => {
    setSyncing(true);
    setNotionError(null);

    try {
      const statusResponse = await fetch("/api/notion/status", { cache: "no-store" });
      const status = await statusResponse.json() as NotionStatus;
      setNotionStatus(status);

      if (!statusResponse.ok || !status.connected) {
        if (status.error) setNotionError(status.error);
        return;
      }

      const graphResponse = await fetch(`/api/notion/graph${force ? "?force=1" : ""}`, { cache: "no-store" });
      const graph = await graphResponse.json() as GraphPayload & { error?: string };
      if (!graphResponse.ok) throw new Error(graph.error || "Der Notion-Graph konnte nicht geladen werden.");

      setNodes(graph.nodes);
      setEdges(graph.edges);
      setGraphMeta({
        syncedAt: graph.syncedAt,
        pageCount: graph.pageCount,
        dataSourceCount: graph.dataSourceCount,
        contentScannedCount: graph.contentScannedCount,
        similarityEdgeCount: graph.similarityEdgeCount,
        clusterCount: graph.clusterCount,
      });
      setSelectedNode(graph.nodes.find((node) => node.kind === "system") ?? graph.nodes[0]);
    } catch (error) {
      setNotionError(error instanceof Error ? error.message : "Notion ist momentan nicht erreichbar.");
    } finally {
      setSyncing(false);
    }
  }, []);

  const loadBriefing = useCallback(async (force = false) => {
    setBriefingLoading(true);
    setBriefingError(null);
    try {
      const response = await fetch(`/api/briefing${force ? "?force=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as DailyBriefing & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Das Morning Briefing konnte nicht geladen werden.");
      setBriefing(payload);
      window.localStorage.setItem(BRIEFING_CACHE_KEY, JSON.stringify(payload));
    } catch (error) {
      setBriefingError(error instanceof Error ? error.message : "Die Quellen sind momentan nicht erreichbar.");
    } finally {
      setBriefingLoading(false);
    }
  }, []);

  const loadWeather = useCallback(async (force = false) => {
    setWeatherLoading(true);
    setWeatherError(null);
    try {
      const response = await fetch(`/api/weather${force ? "?force=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as WeatherPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Das Wetter konnte nicht geladen werden.");
      setWeather(payload);
    } catch (error) {
      setWeatherError(error instanceof Error ? error.message : "Das Wetter ist momentan nicht erreichbar.");
    } finally {
      setWeatherLoading(false);
    }
  }, []);

  useEffect(() => {
    const startupCheck = window.setTimeout(() => void loadNotion(), 0);
    return () => window.clearTimeout(startupCheck);
  }, [loadNotion]);

  useEffect(() => {
    const startupWeather = window.setTimeout(() => void loadWeather(), 0);
    const weatherInterval = window.setInterval(() => void loadWeather(), 30 * 60 * 1000);
    return () => {
      window.clearTimeout(startupWeather);
      window.clearInterval(weatherInterval);
    };
  }, [loadWeather]);

  useEffect(() => {
    const startupBriefing = window.setTimeout(() => {
      try {
        const cached = window.localStorage.getItem(BRIEFING_CACHE_KEY);
        const hidden = window.localStorage.getItem(BRIEFING_HIDDEN_KEY);
        const saved = window.localStorage.getItem(BRIEFING_SAVED_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as DailyBriefing;
          const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
          if (parsed.date === today) setBriefing(parsed);
        }
        if (hidden) setHiddenBriefingIds(JSON.parse(hidden) as string[]);
        if (saved) setSavedBriefingIds(JSON.parse(saved) as string[]);
      } catch {
        window.localStorage.removeItem(BRIEFING_CACHE_KEY);
      }
      void loadBriefing();
    }, 0);
    return () => window.clearTimeout(startupBriefing);
  }, [loadBriefing]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    const updateFooterDate = () => setFooterDate(new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date()).toUpperCase());
    const startupDate = window.setTimeout(updateFooterDate, 0);
    const dateInterval = window.setInterval(updateFooterDate, 60_000);
    return () => {
      window.clearTimeout(startupDate);
      window.clearInterval(dateInterval);
    };
  }, []);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.kind === "system") continue;
      counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
  }, [nodes]);

  const selectedConnections = useMemo(() => edges.filter(
    (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
  ).length, [edges, selectedNode.id]);

  const visibleBriefingItems = useMemo(
    () => briefing?.items.filter((item) => !hiddenBriefingIds.includes(item.id)) ?? [],
    [briefing, hiddenBriefingIds],
  );

  const importantBriefingItems = useMemo(
    () => visibleBriefingItems.filter((item) => item.priority === "important"),
    [visibleBriefingItems],
  );

  const usefulBriefingItems = useMemo(
    () => visibleBriefingItems.filter((item) => item.priority === "worth_knowing"),
    [visibleBriefingItems],
  );

  const hideBriefingItem = (id: string) => {
    setHiddenBriefingIds((current) => {
      const next = [...new Set([...current, id])];
      window.localStorage.setItem(BRIEFING_HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  };

  const toggleSavedBriefingItem = (id: string) => {
    setSavedBriefingIds((current) => {
      const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
      window.localStorage.setItem(BRIEFING_SAVED_KEY, JSON.stringify(next));
      return next;
    });
  };

  const renderBriefingGroup = (label: string, items: BriefingItem[]) => items.length ? (
    <section className="briefing-group" aria-label={label}>
      <span className="briefing-section-label">{label}</span>
      {items.map((item) => (
        <article className="briefing-card" key={item.id}>
          <div className="briefing-meta">
            <span><i className={`priority-dot ${item.priority}`} />{item.sourceLabel}</span>
            <span>{formatBriefingAge(item.publishedAt)} · {item.score.toFixed(1)}</span>
          </div>
          <h3>{item.title}</h3>
          <p>{item.summary}</p>
          <div className="briefing-topics">
            {item.matchedTopics.slice(0, 2).map((topic) => <span key={topic}>{topic}</span>)}
          </div>
          <div className="briefing-actions">
            <button onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}>ÖFFNEN ↗</button>
            <button
              className={savedBriefingIds.includes(item.id) ? "is-saved" : ""}
              onClick={() => toggleSavedBriefingItem(item.id)}
            >
              {savedBriefingIds.includes(item.id) ? "GEMERKT ✓" : "MERKEN"}
            </button>
            <button onClick={() => hideBriefingItem(item.id)} aria-label={`${item.title} als nicht relevant markieren`}>NICHT RELEVANT</button>
          </div>
        </article>
      ))}
    </section>
  ) : null;

  const selectGroup = (group: string) => {
    const node = nodes.find((candidate) => candidate.group === group);
    if (node) setSelectedNode(node);
    setMode("map");
  };

  const runQuery = (event: FormEvent) => {
    event.preventDefault();
    const cleanQuery = query.trim();
    if (!cleanQuery) return;
    setState("thinking");
    setResponse(null);
    timerRef.current = setTimeout(() => {
      setState("idle");
      setResponse(`Ich habe 7 relevante Notizen zu „${cleanQuery}“ in Universität, Projekte und Ideen gefunden.`);
    }, 1500);
  };

  const toggleListening = () => {
    if (state === "listening") {
      setState("thinking");
      timerRef.current = setTimeout(() => {
        setState("idle");
        setResponse("Gedanke erkannt. Im nächsten Schritt würde daraus eine Notion-Notiz oder Aufgabe entstehen.");
      }, 1200);
    } else {
      setResponse(null);
      setState("listening");
    }
  };

  const statusText = state === "listening" ? "ICH HÖRE ZU" : state === "thinking" ? "ICH VERBINDE WISSEN" : "SYSTEM BEREIT";

  return (
    <main className="jarvis-shell">
      <div className="grid-noise" aria-hidden="true" />
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-block">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <div>
              <strong>JARVIS</strong>
              <span>PERSONAL KNOWLEDGE INTERFACE</span>
            </div>
          </div>
          <section className={`weather-compact ${weatherLoading ? "is-loading" : ""}`} aria-live="polite" title={weatherError || undefined}>
            {weather ? (
              <>
                <span className="weather-symbol" aria-hidden="true">{weather.current.symbol}</span>
                <strong className="weather-temperature">{Math.round(weather.current.temperature)}°</strong>
                <span className="weather-details">
                  <b>{weather.location}</b>
                  <small>
                    {weather.current.label} · H {Math.round(weather.today.max)}° / T {Math.round(weather.today.min)}° · {Math.round(weather.today.rainChance)}% REGEN
                    {" · "}<a href={weather.attribution.url} target="_blank" rel="noreferrer">OPEN-METEO</a>
                  </small>
                </span>
              </>
            ) : weatherError ? (
              <button type="button" className="weather-retry" onClick={() => void loadWeather(true)}>WETTER OFFLINE · ↻</button>
            ) : (
              <><span className="weather-symbol" aria-hidden="true">○</span><span className="weather-loading-label">WETTER</span></>
            )}
          </section>
        </div>
        <div className="system-meta">
          <span className="prototype-label">VISUAL PROTOTYPE / 01</span>
          <button
            className={`notion-status-button ${notionStatus.connected ? "connected" : ""}`}
            onClick={() => setSetupOpen(true)}
          >
            <i /> {syncing ? "SYNCING" : notionStatus.connected ? "NOTION READY" : "NOTION SETUP"}
          </button>
          <span className="live-dot"><i /> LOCAL</span>
        </div>
      </header>

      <aside className="index-panel" aria-label="Wissensübersicht">
        <span className="eyebrow">NEURAL INDEX</span>
        <strong>{Math.max(0, nodes.filter((node) => node.kind !== "system").length)}</strong>
        <span className="index-caption">{notionStatus.connected ? "ECHTE KNOTEN" : "DEMO-KNOTEN"}</span>
        <div className="index-list">
          {groupCounts.map(([group, count]) => (
            <button key={group} onClick={() => selectGroup(group)}><i /> {group} <b>{count}</b></button>
          ))}
        </div>
      </aside>

      <section className="visual-stage">
        <NeuralCanvas
          state={state}
          mode={mode}
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedNode.id}
          onSelect={setSelectedNode}
        />
        {mode === "core" && (
          <div className={`core-status state-${state}`}>
            <span>{statusText}</span>
            <i />
          </div>
        )}
        {mode === "core" && (
          <div className="core-copy">
            <span>{state === "listening" ? "SPRICH EINFACH LOS" : state === "thinking" ? "MUSTER WERDEN ANALYSIERT" : "DEIN WISSEN. VERBUNDEN."}</span>
          </div>
        )}
      </section>

      <aside className={`context-panel ${mode === "map" ? "is-visible" : ""}`} aria-live="polite">
        <span className="eyebrow">AUSGEWÄHLTER KNOTEN</span>
        <h2>{selectedNode.icon ? <span className="node-icon">{selectedNode.icon}</span> : null}{selectedNode.label}</h2>
        <p>{selectedNode.content || (selectedNode.kind === "system"
          ? `${graphMeta?.clusterCount ?? groupCounts.length} lokale Themencluster mit ${graphMeta?.similarityEdgeCount ?? 0} automatisch erkannten Ähnlichkeiten.`
          : `Verknüpfte Notion-Inhalte und semantische Beziehungen rund um ${selectedNode.label}.`)}</p>
        {selectedNode.keywords?.length ? (
          <div className="keyword-list" aria-label="Erkannte Schlüsselbegriffe">
            {selectedNode.keywords.slice(0, 4).map((keyword) => <span key={keyword}>{keyword}</span>)}
          </div>
        ) : null}
        <div className="context-stats">
          <span><b>{selectedNode.group}</b> Bereich</span>
          <span><b>{String(selectedConnections).padStart(2, "0")}</b> Verbindungen</span>
        </div>
        <button
          className="text-action"
          disabled={!selectedNode.url}
          onClick={() => selectedNode.url && window.open(selectedNode.url, "_blank", "noopener,noreferrer")}
        >
          {selectedNode.url ? "IN NOTION ÖFFNEN" : "LOKALE SYSTEMANSICHT"} <span>↗</span>
        </button>
      </aside>

      <aside className={`briefing-panel ${mode === "core" ? "is-visible" : ""}`} aria-live="polite" aria-label="Morning Tech Briefing">
        <header className="briefing-header">
          <div>
            <span className="eyebrow">MORNING TECH BRIEF</span>
            <h2>{briefing?.date ? new Date(`${briefing.date}T12:00:00`).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "short" }) : "Heute"}</h2>
          </div>
          <button className="briefing-refresh" disabled={briefingLoading} onClick={() => void loadBriefing(true)} aria-label="Briefing aktualisieren">
            {briefingLoading ? "···" : "↻"}
          </button>
        </header>

        {briefingLoading && !briefing ? (
          <div className="briefing-loading"><i /><i /><i /><span>QUELLEN WERDEN GEPRÜFT</span></div>
        ) : null}
        {briefingError ? (
          <div className="briefing-error">
            <p>{briefingError}</p>
            <button onClick={() => void loadBriefing(true)}>ERNEUT VERSUCHEN</button>
          </div>
        ) : null}
        {briefing && !visibleBriefingItems.length && !briefingError ? (
          <div className="briefing-empty">
            <strong>Heute kein Rauschen.</strong>
            <p>Keine Meldung hat den Relevanzfilter passiert oder du hast alle ausgeblendet.</p>
          </div>
        ) : null}
        {renderBriefingGroup("WICHTIG FÜR DICH", importantBriefingItems)}
        {renderBriefingGroup("WISSENSWERT", usefulBriefingItems)}

        {briefing?.glossary && visibleBriefingItems.some((item) => item.id === briefing.glossary?.sourceItemId) ? (
          <section className="glossary-card">
            <span className="briefing-section-label">BEGRIFF DES TAGES</span>
            <h3>{briefing.glossary.term}</h3>
            <p>{briefing.glossary.definition}</p>
            <span>{briefing.glossary.whyItMatters}</span>
          </section>
        ) : null}

        {briefing ? (
          <footer className="briefing-sources" title={briefing.sourceStatus.map((status) => `${status.label}: ${status.ok ? `${status.count} geladen` : "nicht erreichbar"}`).join(" · ")}>
            {briefing.sourceStatus.filter((status) => status.ok).length}/{briefing.sourceStatus.length} QUELLEN · MAX. 10 MELDUNGEN
          </footer>
        ) : null}
      </aside>

      <nav className="mode-switcher" aria-label="Ansicht wechseln">
        <button className={mode === "core" ? "active" : ""} onClick={() => setMode("core")}><i /> CORE</button>
        <button className={mode === "map" ? "active" : ""} onClick={() => setMode("map")}><i /> MAP</button>
      </nav>

      <section className="command-area">
        {response && <div className="response-line"><span>J</span><p>{response}</p><button onClick={() => setResponse(null)} aria-label="Antwort schließen">×</button></div>}
        <form className="command-bar" onSubmit={runQuery}>
          <span className="prompt-symbol">›</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ask a question"
            aria-label="Jarvis befragen"
          />
          <span className="key-hint">ENTER</span>
          <button type="button" className={`mic-button ${state === "listening" ? "active" : ""}`} onClick={toggleListening} aria-label={state === "listening" ? "Aufnahme beenden" : "Spracheingabe starten"}>
            <span className="mic-icon" />
          </button>
        </form>
        <div className="quick-prompts">
          <button onClick={() => setQuery("Was verbindet meine aktuellen Projekte?")}>PROJEKTE VERBINDEN</button>
          <button onClick={() => setQuery("Zeig mir meine Notizen zur Prüfung")}>PRÜFUNGSWISSEN</button>
          <button onClick={() => setQuery("Neue Idee festhalten")}>IDEE FESTHALTEN</button>
        </div>
      </section>

      <footer className="footer-line">
        <span>NOTION <i /> {notionStatus.connected ? `${graphMeta?.pageCount ?? 0} SEITEN` : "DEMO DATA"}</span>
        <span>{briefing ? `BRIEFING ${visibleBriefingItems.length} NEWS` : graphMeta ? `SYNC ${new Date(graphMeta.syncedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}` : "LOCAL CORE / M4"}</span>
        <span>{footerDate}</span>
      </footer>

      {setupOpen && (
        <div className="setup-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSetupOpen(false);
        }}>
          <section className="setup-panel" role="dialog" aria-modal="true" aria-labelledby="notion-setup-title">
            <header className="setup-head">
              <div>
                <span className="eyebrow">LOCAL DATA CONNECTION</span>
                <h2 id="notion-setup-title">Notion verbinden</h2>
              </div>
              <button className="setup-close" onClick={() => setSetupOpen(false)} aria-label="Dialog schließen">×</button>
            </header>

            <div className={`connection-card ${notionStatus.connected ? "connected" : ""}`}>
              <i />
              <div>
                <strong>{notionStatus.connected ? "Verbindung aktiv" : "Noch nicht verbunden"}</strong>
                <span>{notionStatus.connected
                  ? `${notionStatus.workspaceName || "Notion Workspace"} · nur lesend`
                  : "Dein Token bleibt ausschließlich lokal auf diesem MacBook."}</span>
              </div>
            </div>

            {notionStatus.connected ? (
              <div className="connected-summary">
                <div><b>{graphMeta?.pageCount ?? 0}</b><span>Seiten</span></div>
                <div><b>{graphMeta?.dataSourceCount ?? 0}</b><span>Datenquellen</span></div>
                <div><b>{graphMeta?.similarityEdgeCount ?? 0}</b><span>Ähnlichkeiten</span></div>
              </div>
            ) : (
              <ol className="setup-steps">
                <li><span className="setup-number">01</span><div><strong>Interne Integration anlegen</strong><p>Erstelle in Notion eine Integration namens JARVIS und erteile nur Leserechte.</p></div></li>
                <li><span className="setup-number">02</span><div><strong>Ausgewählte Inhalte freigeben</strong><p>Verbinde nur die Notion-Seiten und Datenbanken, die JARVIS sehen darf.</p></div></li>
                <li><span className="setup-number">03</span><div><strong>Token lokal eintragen</strong><p>Lege im Projekt eine Datei <code>.env.local</code> an:</p><pre>NOTION_ACCESS_TOKEN=secret_dein_token</pre></div></li>
              </ol>
            )}

            {(notionError || notionStatus.error) && <p className="setup-error">{notionError || notionStatus.error}</p>}

            <div className="setup-actions">
              {!notionStatus.connected && (
                <button className="secondary-action" onClick={() => window.open("https://www.notion.so/my-integrations", "_blank", "noopener,noreferrer")}>NOTION INTEGRATION ↗</button>
              )}
              <button className="primary-action" disabled={syncing} onClick={() => void loadNotion(true)}>
                {syncing ? "WIRD SYNCHRONISIERT …" : notionStatus.connected ? "JETZT SYNCHRONISIEREN" : "STATUS PRÜFEN"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
