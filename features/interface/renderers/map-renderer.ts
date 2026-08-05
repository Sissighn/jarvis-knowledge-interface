import type { ConceptEdge, ConceptNode } from "../types";
import { mapGroupMotion, mapNodeMotion, quadraticPoint, stableUnit } from "../map/map-motion";
import { stepForceSimulation, type ForceSimulation } from "../map/force-simulation";
import type { MapPoint } from "../map/types";
import { mapSceneCenter, worldToScreen, type MapViewport, type Point } from "../map/map-viewport";
import {
  beginNeuralInk,
  endNeuralInk,
  fillNeuralHalo,
  fillNeuralPoint,
  fillNeuralPulse,
  neuralDepthAlpha,
  neuralDepthScale,
  strokeNeuralFilament,
  strokeNeuralLink,
  strokeNeuralTrail,
} from "./neural-style";

type Options = {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  time: number;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  selectedNodeId: string;
  highlightedNodeIds: string[];
  hoveredNodeId: string | null;
  mapPoints: { current: MapPoint[] };
  trails: { current: Map<string, Point[]> };
  viewport: MapViewport;
  focusActive: boolean;
  reducedMotion: boolean;
  simulation: ForceSimulation;
};

/** Matches the radial boundary the force simulation keeps its concepts inside. */
const FIELD_RADIUS = 0.46;
const TRAIL_LENGTH = 16;

// Seeded once: the strands drift over time, but never jump between frames or reloads.
const FILAMENTS = Array.from({ length: 26 }, (_, index) => {
  const seed = `map-filament-${index}`;
  return {
    angle: stableUnit(seed, 11) * Math.PI * 2,
    distance: 0.14 + stableUnit(seed, 23) * 0.3,
    phase: stableUnit(seed, 37) * Math.PI * 2,
    speed: 0.04 + stableUnit(seed, 53) * 0.1,
    span: 0.9 + stableUnit(seed, 71) * 1.8,
    alpha: 0.028 + stableUnit(seed, 89) * 0.07,
  };
});

export function renderMapFrame({
  context, width, height, time, nodes, edges, selectedNodeId, highlightedNodeIds,
  hoveredNodeId, mapPoints, trails, viewport, focusActive, reducedMotion, simulation,
}: Options) {
  const center = mapSceneCenter(width, height);
  // The same slow breath the core sphere uses, so the graph never sits perfectly still.
  const breathing = reducedMotion ? 1 : 1 + Math.sin(time * 1.2) * 0.018;
  const radius = Math.max(120, Math.min(width * 0.68, height * 0.72, 720)) * breathing;
  simulation.radius = radius;
  stepForceSimulation(simulation, nodes, reducedMotion);

  const positioned = nodes.map((node) => {
    const force = simulation.points.get(node.id) ?? { x: node.x, y: node.y };
    const world = { x: center.x + force.x * radius, y: center.y + force.y * radius };
    const screen = worldToScreen(world, viewport, center);
    const root = node.kind === "system";
    // Drift keeps every concept subtly in motion, the way particles orbit in the core.
    const drift = root ? { x: 0, y: 0 } : mapNodeMotion(node.id, time, reducedMotion);
    const groupDrift = root ? { x: 0, y: 0 } : mapGroupMotion(node.group, time, reducedMotion);
    // Distance from the middle stands in for the sphere's z axis: the centre is the front.
    const depth = Math.cos(Math.min(1, Math.hypot(force.x, force.y) / FIELD_RADIUS) * Math.PI / 2);
    return {
      node,
      worldX: world.x,
      worldY: world.y,
      x: screen.x + drift.x + groupDrift.x,
      y: screen.y + drift.y + groupDrift.y,
      depth,
    };
  });
  mapPoints.current = positioned;
  const byId = new Map(positioned.map((point) => [point.node.id, point]));
  const selected = byId.get(selectedNodeId)?.node;
  const matches = new Set(highlightedNodeIds);
  const related = new Set<string>([selectedNodeId]);
  for (const edge of edges) {
    if (edge.source === selectedNodeId) related.add(edge.target);
    if (edge.target === selectedNodeId) related.add(edge.source);
  }

  const isActive = (nodeId: string) => nodeId === selectedNodeId || nodeId === hoveredNodeId || matches.has(nodeId);

  for (const id of trails.current.keys()) if (!byId.has(id)) trails.current.delete(id);
  if (!reducedMotion) {
    for (const point of positioned) {
      const trail = trails.current.get(point.node.id) ?? [];
      trail.push({ x: point.x, y: point.y });
      if (trail.length > TRAIL_LENGTH) trail.shift();
      trails.current.set(point.node.id, trail);
    }
  }

  beginNeuralInk(context);

  // Category fields are derived from the current simulation, so they move with their concepts.
  const categoryPoints = new Map<string, typeof positioned>();
  for (const point of positioned) {
    if (point.node.kind !== "concept") continue;
    categoryPoints.set(point.node.group, [...(categoryPoints.get(point.node.group) ?? []), point]);
  }
  const categoryLabels: Array<{ category: string; x: number; y: number }> = [];
  for (const [category, points] of categoryPoints) {
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const spread = Math.max(34, Math.min(120, Math.max(...points.map((point) => Math.hypot(point.x - x, point.y - y))) + 24));
    const gradient = context.createRadialGradient(x, y, 0, x, y, spread);
    gradient.addColorStop(0, "rgba(255,205,229,.05)");
    gradient.addColorStop(1, "rgba(255,205,229,0)");
    context.fillStyle = gradient;
    context.beginPath(); context.arc(x, y, spread, 0, Math.PI * 2); context.fill();
    categoryLabels.push({ category, x, y: y - spread * 0.58 });
  }

  // Filaments sweep through the concept cloud in world space, so they pan and zoom with it.
  if (!reducedMotion) {
    for (const filament of FILAMENTS) {
      strokeNeuralFilament(context, filament.alpha, 34, (progress) => {
        const angle = filament.angle + time * filament.speed + progress * filament.span;
        const distance = filament.distance + Math.sin(progress * 7 + filament.phase + time * 0.7) * 0.085;
        return worldToScreen({
          x: center.x + Math.cos(angle) * distance * radius,
          y: center.y + Math.sin(angle) * distance * radius * 0.9,
        }, viewport, center);
      });
    }
    for (const [id, trail] of trails.current) strokeNeuralTrail(context, trail, isActive(id));
  }

  // Every real relation is present; unrelated edges remain quiet rather than disappearing.
  for (const [index, edge] of edges.entries()) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const active = isActive(edge.source) || isActive(edge.target);
    const search = matches.has(edge.source) && matches.has(edge.target);
    const explicit = edge.explicit || edge.type === "notion_relation" || edge.type === "page_mention";
    const opacity = active ? 0.7 : search ? 0.38 : explicit ? 0.14 : focusActive ? 0.025 : 0.07;
    // The core's animated bow, widened by span so long relations still curve visibly.
    const bow = Math.sin(index * 1.7 + time * 1.7) * 4 + Math.hypot(b.x - a.x, b.y - a.y) * 0.05;
    const control = strokeNeuralLink(context, a, b, opacity, bow);
    if (!reducedMotion && (active || explicit)) {
      const progress = (time * (active ? 0.32 : 0.18) + edge.source.length * 0.031) % 1;
      fillNeuralPulse(context, quadraticPoint(a, control, b, progress), active ? 7 : 4);
    }
  }

  for (const [index, point] of positioned.entries()) {
    const { node } = point;
    const root = node.kind === "system";
    const active = isActive(node.id);
    context.globalAlpha = !focusActive || root || related.has(node.id) ? 1 : 0.18;
    const pulse = active && !reducedMotion ? 1 + Math.sin(time * 1.5 + index) * 0.1 : 1;
    const scale = neuralDepthScale(point.depth) * pulse;
    fillNeuralPoint(context, point.x, point.y, {
      alpha: active ? 1 : neuralDepthAlpha(point.depth),
      radius: (root ? 1.9 : Math.max(0.5, Math.min(2.4, node.size * 0.34))) * scale,
      bright: root || active || node.importance > 0.72,
      glowRadius: (root ? 20 : active ? 16 : 9) * scale,
    });
  }
  context.globalAlpha = 1;

  endNeuralInk(context);

  const focusPoint = worldToScreen(center, viewport, center);
  fillNeuralHalo(context, {
    x: focusPoint.x,
    y: focusPoint.y,
    radius: radius * 0.5 * viewport.zoom,
    width,
    height,
    accent: "rgba(255,193,222,.035)",
  });

  // Text stays out of the additive pass so labels keep their contrast.
  context.textAlign = "center";
  for (const label of categoryLabels) {
    context.font = "8px var(--font-geist-mono), monospace";
    context.fillStyle = selected?.group === label.category ? "rgba(255,232,243,.74)" : "rgba(164,133,147,.42)";
    context.fillText(label.category.toLocaleUpperCase("de-DE").slice(0, 28), label.x, label.y);
  }

  const labels: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  for (const point of positioned) {
    const { node } = point;
    if (node.kind === "system") continue;
    const active = isActive(node.id);
    context.globalAlpha = !focusActive || related.has(node.id) ? 1 : 0.18;
    const important = node.importance > 0.72 || node.sourceCount > 2;
    if (!active && !matches.has(node.id) && !(viewport.zoom > 1.15 && important) && !(!focusActive && node.importance > 0.9)) continue;
    const label = node.label.slice(0, active ? 42 : 28);
    context.font = `${active ? 10 : 8}px var(--font-geist-mono), monospace`;
    const labelWidth = context.measureText(label).width + 10;
    const y = point.y + 16;
    const box = { left: point.x - labelWidth / 2, right: point.x + labelWidth / 2, top: y - 11, bottom: y + 4 };
    const collision = labels.some((other) => !(box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom));
    if (!collision || active) {
      labels.push(box);
      context.fillStyle = active ? "rgba(255,247,251,.98)" : "rgba(210,181,195,.72)";
      context.fillText(label, point.x, y);
    }
  }
  context.globalAlpha = 1;

  const root = positioned.find((point) => point.node.kind === "system");
  if (root) {
    context.font = "9px var(--font-geist-mono), monospace";
    context.fillStyle = "rgba(255,234,244,.88)";
    context.fillText(root.node.label.toLocaleUpperCase("de-DE"), root.x, root.y + 22);
  }
  if (!nodes.some((node) => node.kind === "concept")) {
    context.font = "10px var(--font-geist-mono), monospace";
    context.fillStyle = "rgba(190,155,171,.68)";
    context.fillText("WÄHLE NOTION-DATENBANKEN IM SETUP", center.x, center.y + 58);
  }
}
