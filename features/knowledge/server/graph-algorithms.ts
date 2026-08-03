/** Pure semantic analysis and deterministic layout for the knowledge graph. */
import type { KnowledgeEdge, KnowledgeNode } from "../types";

type SparseVector = Map<string, number>;

const SIMILARITY_NEIGHBORS = 4;
const SIMILARITY_THRESHOLD = 0.09;
const STOP_WORDS = new Set([
  "aber", "alle", "allem", "allen", "aller", "alles", "also", "and", "auch", "auf", "aus",
  "bei", "bin", "bis", "bist", "das", "dass", "dein", "deine", "dem", "den", "der", "des",
  "die", "dies", "diese", "ein", "eine", "einem", "einen", "einer", "eines", "für", "from",
  "hat", "ich", "ihre", "ihren", "im", "in", "ist", "mit", "nach", "nicht", "noch", "oder",
  "ohne", "sich", "sie", "sind", "the", "titel", "und", "uns", "von", "vor", "was", "wie",
  "wir", "with", "you", "your", "zum", "zur", "über", "übung", "übungen",
  "seite", "seiten", "datenbank", "datenbanken", "notion",
]);

function tokenize(text: string) {
  return (text.toLocaleLowerCase("de-DE").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

export function buildTfIdfVectors(nodes: KnowledgeNode[]) {
  const documents = nodes.map((node) => {
    const title = tokenize(node.label);
    const metadata = tokenize(`${node.group} ${node.content ?? ""}`);
    return [...title, ...title, ...title, ...metadata];
  });
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return documents.map((document, index) => {
    const counts = new Map<string, number>();
    for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
    const vector: SparseVector = new Map();
    for (const [term, count] of counts) {
      const tf = 1 + Math.log(count);
      const idf = Math.log((documents.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
      vector.set(term, tf * idf);
    }
    normalizeVector(vector);
    nodes[index].keywords = [...vector.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([term]) => term);
    return vector;
  });
}

export function addSimilarityEdges(
  nodes: KnowledgeNode[],
  vectors: SparseVector[],
  addEdge: (
    source: string,
    target: string,
    type: KnowledgeEdge["type"],
    weight?: number,
    reason?: string,
  ) => void,
) {
  const candidates: Array<{ left: number; right: number; score: number }> = [];
  for (let left = 0; left < nodes.length; left++) {
    for (let right = left + 1; right < nodes.length; right++) {
      let score = cosineSimilarity(vectors[left], vectors[right]);
      const meaningfulSharedGroup = nodes[left].group === nodes[right].group
        && !["Seiten", "Datenbanken"].includes(nodes[left].group);
      if (meaningfulSharedGroup) score = Math.min(1, score + 0.06);
      if (score >= SIMILARITY_THRESHOLD) candidates.push({ left, right, score });
    }
  }

  const semanticDegree = new Map<string, number>();
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    const left = nodes[candidate.left];
    const right = nodes[candidate.right];
    if ((semanticDegree.get(left.id) ?? 0) >= SIMILARITY_NEIGHBORS) continue;
    if ((semanticDegree.get(right.id) ?? 0) >= SIMILARITY_NEIGHBORS) continue;
    const sharedKeywords = (left.keywords ?? []).filter((term) => right.keywords?.includes(term)).slice(0, 3);
    addEdge(
      left.id,
      right.id,
      "similarity",
      candidate.score,
      sharedKeywords.length ? sharedKeywords.join(", ") : "ähnlicher Inhalt",
    );
    semanticDegree.set(left.id, (semanticDegree.get(left.id) ?? 0) + 1);
    semanticDegree.set(right.id, (semanticDegree.get(right.id) ?? 0) + 1);
  }
}

export function assignSemanticClusters(nodes: KnowledgeNode[], vectors: SparseVector[]) {
  if (nodes.length === 0) return 0;
  const clusterCount = nodes.length < 5
    ? 1
    : clamp(Math.round(Math.sqrt(nodes.length / 2)), 3, 7);
  const seedIndexes: number[] = [vectors
    .map((vector, index) => ({ index, terms: vector.size }))
    .sort((a, b) => b.terms - a.terms)[0].index];

  while (seedIndexes.length < clusterCount) {
    let bestIndex = 0;
    let bestDistance = -1;
    for (let index = 0; index < vectors.length; index++) {
      if (seedIndexes.includes(index)) continue;
      const distance = Math.min(...seedIndexes.map((seed) => 1 - cosineSimilarity(vectors[index], vectors[seed])));
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    seedIndexes.push(bestIndex);
  }

  let centroids = seedIndexes.map((index) => new Map(vectors[index]));
  const assignments = new Array(nodes.length).fill(0) as number[];
  for (let iteration = 0; iteration < 8; iteration++) {
    for (let index = 0; index < vectors.length; index++) {
      let bestCluster = index % clusterCount;
      let bestScore = -1;
      for (let cluster = 0; cluster < centroids.length; cluster++) {
        const score = cosineSimilarity(vectors[index], centroids[cluster]);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }
      assignments[index] = bestCluster;
    }
    centroids = centroids.map((_, cluster) => averageVectors(
      vectors.filter((__, index) => assignments[index] === cluster),
    ));
  }

  const usedNames = new Set<string>();
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const titleTermScores = new Map<string, number>();
    assignments.forEach((assignment, index) => {
      if (assignment !== cluster) return;
      for (const term of tokenize(nodes[index].label)) {
        titleTermScores.set(term, (titleTermScores.get(term) ?? 0) + (centroids[cluster].get(term) ?? 0.08));
      }
    });
    const titleTerms = [...titleTermScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);
    const centroidTerms = [...centroids[cluster].entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);
    const rankedTerms = [...new Set([...titleTerms, ...centroidTerms])];
    const baseName = rankedTerms.length
      ? rankedTerms.slice(0, 2).map(titleCase).join(" · ")
      : `Thema ${cluster + 1}`;
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) name = `${baseName} ${suffix++}`;
    usedNames.add(name);
    assignments.forEach((assignment, index) => {
      if (assignment === cluster) nodes[index].group = name;
    });
  }
  return new Set(assignments).size;
}

function averageVectors(vectors: SparseVector[]) {
  const average: SparseVector = new Map();
  for (const vector of vectors) {
    for (const [term, value] of vector) average.set(term, (average.get(term) ?? 0) + value);
  }
  if (vectors.length > 0) {
    for (const [term, value] of average) average.set(term, value / vectors.length);
  }
  normalizeVector(average);
  return average;
}

function normalizeVector(vector: SparseVector) {
  const magnitude = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  for (const [term, value] of vector) vector.set(term, value / magnitude);
  return vector;
}

function cosineSimilarity(left: SparseVector, right: SparseVector) {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let score = 0;
  for (const [term, value] of small) score += value * (large.get(term) ?? 0);
  return score;
}

export function edgeWeight(type: KnowledgeEdge["type"]) {
  if (type === "relation") return 1;
  if (type === "mention") return 0.92;
  if (type === "parent" || type === "child") return 0.82;
  if (type === "root") return 0.42;
  return 0.3;
}

export function getWeightedDegree(nodes: KnowledgeNode[], edges: KnowledgeEdge[]) {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    const weight = edge.weight ?? edgeWeight(edge.type);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + weight);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + weight);
  }
  return degree;
}

export function sizeNodes(nodes: KnowledgeNode[], edges: KnowledgeEdge[]) {
  const degree = getWeightedDegree(nodes, edges);
  for (const node of nodes) {
    if (node.kind === "system") {
      node.size = 7;
      continue;
    }
    const base = node.kind === "data_source" ? 3.7 : 2.7;
    node.size = clamp(base + Math.sqrt(degree.get(node.id) ?? 0) * 0.75, 2.7, 5.8);
  }
}

function titleCase(value: string) {
  return value.charAt(0).toLocaleUpperCase("de-DE") + value.slice(1);
}

export function layoutGraph(nodes: KnowledgeNode[]) {
  const contentNodes = nodes.filter((node) => node.kind !== "system");
  const groups = [...new Set(contentNodes.map((node) => node.group))]
    .sort((left, right) => contentNodes.filter((node) => node.group === right).length
      - contentNodes.filter((node) => node.group === left).length);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (const [groupIndex, group] of groups.entries()) {
    const members = contentNodes.filter((node) => node.group === group);
    const clusterAngle = (groupIndex / Math.max(groups.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const clusterRadius = groups.length === 1 ? 0 : 0.31;
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

  // A small deterministic collision pass keeps dense clusters readable without a browser physics engine.
  for (let iteration = 0; iteration < 70; iteration++) {
    for (let left = 0; left < contentNodes.length; left++) {
      for (let right = left + 1; right < contentNodes.length; right++) {
        const a = contentNodes[left];
        const b = contentNodes[right];
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
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
