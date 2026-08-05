import assert from "node:assert/strict";
import test from "node:test";
import { renderMapFrame } from "../../features/interface/renderers/map-renderer";
import { createForceSimulation } from "../../features/interface/map/force-simulation";
import { createMapViewport } from "../../features/interface/map/map-viewport";
import type { Point } from "../../features/interface/map/map-viewport";
import type { MapPoint } from "../../features/interface/map/types";
import type { ConceptEdge, ConceptNode } from "../../features/interface/types";

/** Records which canvas operations a frame performs, without a real canvas. */
function stubContext() {
  const operations: string[] = [];
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(_target, property: string) {
      if (property === "createRadialGradient") return () => { operations.push(property); return gradient; };
      if (property === "measureText") return () => ({ width: 40 });
      return () => { operations.push(property); };
    },
    set(_target, property: string) { operations.push(`set:${property}`); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { context, operations };
}

function concept(id: string, group: string, importance: number): ConceptNode {
  return {
    id, label: id.toUpperCase(), description: "", category: group, aliases: [],
    importance, sourceCount: 3, occurrenceCount: 4, lastSeenAt: "",
    kind: "concept", group, x: 0, y: 0, size: 6,
  };
}

const ROOT: ConceptNode = { ...concept("jarvis-knowledge-root", "System", 1), kind: "system" };
const NODES: ConceptNode[] = [ROOT, concept("alpha", "Design", 0.95), concept("beta", "Design", 0.6), concept("gamma", "Code", 0.8)];
function edge(source: string, target: string, type: ConceptEdge["type"], weight: number, explicit: boolean): ConceptEdge {
  return { source, target, type, weight, explicit, reason: "test", evidenceCount: 1 };
}

const EDGES: ConceptEdge[] = [
  edge("jarvis-knowledge-root", "alpha", "root", 0.5, false),
  edge("alpha", "beta", "notion_relation", 0.8, true),
  edge("beta", "gamma", "co_occurrence", 0.4, false),
];

function renderFrames(count: number, { reducedMotion = false, nodes = NODES, edges = EDGES } = {}) {
  const { context, operations } = stubContext();
  const mapPoints = { current: [] as MapPoint[] };
  const trails = { current: new Map<string, Point[]>() };
  const simulation = createForceSimulation(nodes, edges);
  const viewport = createMapViewport(1200, 700);
  for (let frame = 0; frame < count; frame++) {
    renderMapFrame({
      context, width: 1200, height: 700, time: frame * 0.012, nodes, edges,
      selectedNodeId: "alpha", highlightedNodeIds: ["beta"],
      hoveredNodeId: frame % 2 ? "gamma" : null,
      mapPoints, trails, viewport, focusActive: frame > count / 2, reducedMotion, simulation,
    });
  }
  return { mapPoints, trails, operations };
}

test("keeps every projected map point finite across an animated run", () => {
  const { mapPoints } = renderFrames(60);

  assert.equal(mapPoints.current.length, NODES.length);
  for (const point of mapPoints.current) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${point.node.id} has a non-finite screen position`);
    assert.ok(Number.isFinite(point.worldX) && Number.isFinite(point.worldY), `${point.node.id} has a non-finite world position`);
  }
});

test("draws the core sphere primitives: bowed links, glows and a halo", () => {
  const { operations } = renderFrames(3);

  // Curved links and radial glows are what make the map read like the core sphere.
  assert.ok(operations.includes("quadraticCurveTo"));
  assert.ok(operations.includes("createRadialGradient"));
  assert.ok(operations.includes("fillRect"));
  assert.ok(operations.includes("lineTo"));
});

test("caps motion trails and forgets concepts that left the graph", () => {
  const { trails } = renderFrames(60);

  assert.ok(trails.current.size > 0);
  for (const [id, trail] of trails.current) {
    assert.ok(trail.length <= 16, `${id} kept ${trail.length} trail points`);
  }

  const { trails: pruned } = renderFrames(4, { nodes: [ROOT], edges: [] });
  assert.deepEqual([...pruned.current.keys()], [ROOT.id]);
});

test("renders without motion trails when reduced motion is requested", () => {
  const { trails, mapPoints } = renderFrames(20, { reducedMotion: true });

  assert.equal(trails.current.size, 0);
  assert.equal(mapPoints.current.length, NODES.length);
});

test("renders an empty knowledge graph without throwing", () => {
  assert.doesNotThrow(() => renderFrames(2, { nodes: [ROOT], edges: [] }));
});
