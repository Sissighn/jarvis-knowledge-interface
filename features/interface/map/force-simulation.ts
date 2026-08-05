import type { ConceptEdge, ConceptNode } from "../types";

export type ForcePoint = { x: number; y: number; vx: number; vy: number; pinned: boolean };
export type ForceSimulation = {
  points: Map<string, ForcePoint>;
  edges: ConceptEdge[];
  alpha: number;
  radius: number;
};

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

function seededPosition(node: ConceptNode) {
  if (node.kind === "system") return { x: 0, y: 0 };
  const angle = (hash(node.id) / 0xffffffff) * Math.PI * 2;
  // The API coordinates are deterministic fallbacks, not layout constraints. Starting
  // inside a compact disk lets real graph relations shape the network organically.
  const radius = 0.08 + ((hash(`${node.id}:r`) % 1000) / 1000) * 0.22;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function createForceSimulation(nodes: ConceptNode[], edges: ConceptEdge[]): ForceSimulation {
  const simulation: ForceSimulation = { points: new Map(), edges, alpha: 1, radius: 1 };
  syncForceSimulation(simulation, nodes, edges);
  return simulation;
}

/** Preserves existing positions and seeds new concepts near a connected neighbour. */
export function syncForceSimulation(simulation: ForceSimulation, nodes: ConceptNode[], edges: ConceptEdge[]) {
  const visible = new Set(nodes.map((node) => node.id));
  for (const id of simulation.points.keys()) if (!visible.has(id)) simulation.points.delete(id);
  simulation.edges = edges;
  for (const node of nodes) {
    if (simulation.points.has(node.id)) continue;
    const neighbourId = edges.find((edge) => edge.source === node.id && simulation.points.has(edge.target))?.target
      ?? edges.find((edge) => edge.target === node.id && simulation.points.has(edge.source))?.source;
    const neighbour = neighbourId ? simulation.points.get(neighbourId) : null;
    const seeded = seededPosition(node);
    simulation.points.set(node.id, {
      x: neighbour ? neighbour.x + seeded.x * 0.16 : seeded.x,
      y: neighbour ? neighbour.y + seeded.y * 0.16 : seeded.y,
      vx: 0,
      vy: 0,
      pinned: node.kind === "system",
    });
  }
  simulation.alpha = Math.max(simulation.alpha, 0.55);
}

export function moveForceNode(simulation: ForceSimulation, nodeId: string, dxPixels: number, dyPixels: number, zoom: number) {
  const point = simulation.points.get(nodeId);
  if (!point) return;
  const scale = Math.max(80, simulation.radius) * Math.max(0.3, zoom);
  point.x += dxPixels / scale;
  point.y += dyPixels / scale;
  point.vx = 0;
  point.vy = 0;
  point.pinned = true;
  simulation.alpha = Math.max(simulation.alpha, 0.28);
}

export function releaseForceNode(simulation: ForceSimulation, nodeId: string) {
  const point = simulation.points.get(nodeId);
  if (!point || nodeId === "jarvis-knowledge-root") return;
  point.pinned = false;
  simulation.alpha = Math.max(simulation.alpha, 0.2);
}

export function stepForceSimulation(simulation: ForceSimulation, nodes: ConceptNode[], reducedMotion: boolean) {
  if (reducedMotion) return;
  const active = nodes.filter((node) => node.kind !== "system");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const alpha = Math.max(0.035, simulation.alpha);

  for (let left = 0; left < active.length; left++) {
    const a = simulation.points.get(active[left].id);
    if (!a) continue;
    for (let right = left + 1; right < active.length; right++) {
      const b = simulation.points.get(active[right].id);
      if (!b) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.002) { dx = 0.002; dy = 0; distance = 0.002; }
      const collision = 0.026 + (active[left].size + active[right].size) * 0.0024;
      const repulsion = Math.min(0.0032, 0.0001 / (distance * distance)) * alpha;
      const collisionPush = distance < collision ? (collision - distance) * 0.09 : 0;
      const force = repulsion + collisionPush;
      const nx = dx / distance;
      const ny = dy / distance;
      if (!a.pinned) { a.vx -= nx * force; a.vy -= ny * force; }
      if (!b.pinned) { b.vx += nx * force; b.vy += ny * force; }
    }
  }

  for (const edge of simulation.edges) {
    if (edge.type === "root") continue;
    const a = simulation.points.get(edge.source);
    const b = simulation.points.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.max(0.001, Math.hypot(dx, dy));
    const desired = 0.075 + (1 - Math.min(1, edge.weight)) * 0.07;
    const force = (distance - desired) * (0.018 + edge.weight * 0.022) * alpha;
    if (!a.pinned) { a.vx += (dx / distance) * force; a.vy += (dy / distance) * force; }
    if (!b.pinned) { b.vx -= (dx / distance) * force; b.vy -= (dy / distance) * force; }
  }

  const categoryCenters = new Map<string, { x: number; y: number; count: number }>();
  for (const node of active) {
    const point = simulation.points.get(node.id);
    if (!point) continue;
    const center = categoryCenters.get(node.group) ?? { x: 0, y: 0, count: 0 };
    center.x += point.x; center.y += point.y; center.count += 1;
    categoryCenters.set(node.group, center);
  }
  for (const node of active) {
    const point = simulation.points.get(node.id);
    const center = categoryCenters.get(node.group);
    if (!point || !center || point.pinned) continue;
    point.vx += ((center.x / center.count) - point.x) * 0.0018 * alpha;
    point.vy += ((center.y / center.count) - point.y) * 0.0018 * alpha;
    point.vx += -point.x * 0.0026 * alpha;
    point.vy += -point.y * 0.0026 * alpha;
  }

  for (const [id, point] of simulation.points) {
    if (point.pinned || byId.get(id)?.kind === "system") continue;
    point.vx *= 0.84;
    point.vy *= 0.84;
    point.x += point.vx;
    point.y += point.vy;
    // A radial boundary avoids the rectangular rows that axis-by-axis clamping creates.
    const distance = Math.hypot(point.x, point.y);
    const maximumRadius = 0.46;
    if (distance > maximumRadius) {
      const scale = maximumRadius / distance;
      point.x *= scale;
      point.y *= scale;
      point.vx *= 0.28;
      point.vy *= 0.28;
    }
  }
  simulation.alpha *= 0.992;
}
