/** Deterministic sizing and layout for concept maps, shared by the indexer and tests. */
import type { ConceptEdge, ConceptNode } from "./types";

export const KNOWLEDGE_ROOT_ID = "jarvis-knowledge-root";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function weightedDegree(nodes: ConceptNode[], edges: ConceptEdge[]) {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.weight);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.weight);
  }
  return degree;
}

/** Node size mirrors how broadly a concept is covered, not how recently it was edited. */
export function sizeConceptNodes(nodes: ConceptNode[], edges: ConceptEdge[]) {
  const degree = weightedDegree(nodes, edges);
  for (const node of nodes) {
    if (node.kind === "system") {
      node.size = 7;
      continue;
    }
    node.size = clamp(
      2.6
      + Math.sqrt(node.occurrenceCount) * 0.42
      + Math.sqrt(node.sourceCount) * 0.5
      + node.importance * 0.9
      + Math.sqrt(degree.get(node.id) ?? 0) * 0.3,
      2.6,
      6.2,
    );
  }
  return nodes;
}

export function layoutConceptNodes(nodes: ConceptNode[]) {
  const conceptNodes = nodes.filter((node) => node.kind !== "system");
  const categories = [...new Set(conceptNodes.map((node) => node.group))]
    .sort((left, right) => conceptNodes.filter((node) => node.group === right).length
      - conceptNodes.filter((node) => node.group === left).length
      || left.localeCompare(right, "de"));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (const [categoryIndex, category] of categories.entries()) {
    const members = conceptNodes
      .filter((node) => node.group === category)
      .sort((left, right) => right.size - left.size || left.id.localeCompare(right.id));
    const clusterAngle = (categoryIndex / Math.max(categories.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const clusterRadius = categories.length === 1 ? 0 : 0.31;
    const centerX = Math.cos(clusterAngle) * clusterRadius;
    const centerY = Math.sin(clusterAngle) * clusterRadius * 0.78;
    const spread = Math.min(0.18, 0.075 + Math.sqrt(members.length) * 0.02);
    members.forEach((node, index) => {
      const localRadius = 0.03 + Math.sqrt((index + 1) / Math.max(members.length, 1)) * spread;
      const angle = index * goldenAngle + clusterAngle;
      node.x = clamp(centerX + Math.cos(angle) * localRadius, -0.46, 0.46);
      node.y = clamp(centerY + Math.sin(angle) * localRadius, -0.39, 0.39);
    });
  }

  // A small deterministic collision pass keeps dense clusters readable without a physics engine.
  for (let iteration = 0; iteration < 70; iteration++) {
    for (let left = 0; left < conceptNodes.length; left++) {
      for (let right = left + 1; right < conceptNodes.length; right++) {
        const a = conceptNodes[left];
        const b = conceptNodes[right];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        const minimum = 0.035 + (a.size + b.size) * 0.0022;
        if (distance >= minimum) continue;
        if (distance < 0.0001) {
          dx = Math.cos((left + 1) * goldenAngle) * 0.001;
          dy = Math.sin((right + 1) * goldenAngle) * 0.001;
          distance = Math.hypot(dx, dy);
        }
        const push = (minimum - distance) * 0.24;
        const nx = dx / distance;
        const ny = dy / distance;
        a.x = clamp(a.x - nx * push, -0.47, 0.47);
        a.y = clamp(a.y - ny * push, -0.4, 0.4);
        b.x = clamp(b.x + nx * push, -0.47, 0.47);
        b.y = clamp(b.y + ny * push, -0.4, 0.4);
      }
    }
  }
  return nodes;
}

export function knowledgeRootNode(): ConceptNode {
  return {
    id: KNOWLEDGE_ROOT_ID,
    label: "WISSEN",
    description: "Lokaler Wissensindex aus deinen ausgewählten Notion-Datenbanken.",
    category: "System",
    aliases: [],
    importance: 1,
    sourceCount: 0,
    occurrenceCount: 0,
    lastSeenAt: "",
    kind: "system",
    group: "System",
    x: 0,
    y: 0,
    size: 7,
  };
}

/** Connects the visual hub with the strongest concept of every category. */
export function rootEdges(nodes: ConceptNode[], edges: ConceptEdge[]): ConceptEdge[] {
  const degree = weightedDegree(nodes, edges);
  const strongestByCategory = new Map<string, ConceptNode>();
  for (const node of nodes) {
    if (node.kind === "system") continue;
    const current = strongestByCategory.get(node.group);
    const score = (candidate: ConceptNode) => (degree.get(candidate.id) ?? 0) + candidate.occurrenceCount * 0.1;
    if (!current || score(node) > score(current)) strongestByCategory.set(node.group, node);
  }
  return [...strongestByCategory.values()].map((node): ConceptEdge => ({
    source: KNOWLEDGE_ROOT_ID,
    target: node.id,
    type: "root",
    weight: 0.42,
    reason: `Themenanker für ${node.group}`,
    evidenceCount: 0,
  }));
}
