const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const DEFAULT_PAGE_LIMIT = 80;
const DEFAULT_CONTENT_SCAN_LIMIT = 40;
const SIMILARITY_NEIGHBORS = 4;
const SIMILARITY_THRESHOLD = 0.09;

type JsonRecord = Record<string, unknown>;

type NotionList<T> = {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
};

type NotionRichText = {
  plain_text?: string;
  type?: string;
  text?: { content?: string };
  mention?: { type?: string; page?: { id?: string } };
};

type NotionProperty = JsonRecord & { type?: string };

type NotionPage = JsonRecord & {
  object: "page";
  id: string;
  url?: string;
  last_edited_time?: string;
  parent?: JsonRecord;
  properties?: Record<string, NotionProperty>;
  icon?: JsonRecord | null;
};

type NotionDataSource = JsonRecord & {
  object: "data_source";
  id: string;
  url?: string;
  last_edited_time?: string;
  parent?: JsonRecord;
  title?: NotionRichText[];
  properties?: Record<string, NotionProperty>;
  icon?: JsonRecord | null;
};

type NotionSearchResult = NotionPage | NotionDataSource;
type NotionBlock = JsonRecord & { id: string; type: string; has_children?: boolean };

export type KnowledgeNode = {
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

export type KnowledgeEdge = {
  source: string;
  target: string;
  type: "root" | "parent" | "relation" | "mention" | "child" | "similarity";
  weight?: number;
  reason?: string;
};

export type NotionGraph = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  syncedAt: string;
  pageCount: number;
  dataSourceCount: number;
  contentScannedCount: number;
  similarityEdgeCount: number;
  clusterCount: number;
};

export class NotionConnectionError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "NotionConnectionError";
    this.status = status;
    this.code = code;
  }
}

let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let graphCache: { value: NotionGraph; expiresAt: number } | null = null;

function getAccessToken() {
  return process.env.NOTION_ACCESS_TOKEN?.trim() ?? "";
}

export function isNotionConfigured() {
  return Boolean(getAccessToken());
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeRateLimitTurn() {
  const previous = requestQueue;
  let release = () => {};
  requestQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < 340) await wait(340 - elapsed);
  lastRequestAt = Date.now();
  release();
}

async function notionRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  if (!token) {
    throw new NotionConnectionError("Notion ist noch nicht lokal konfiguriert.", 503, "not_configured");
  }

  await takeRateLimitTurn();
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const payload = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) {
    const message = typeof payload.message === "string"
      ? payload.message
      : "Notion konnte die Anfrage nicht verarbeiten.";
    const code = typeof payload.code === "string" ? payload.code : undefined;
    throw new NotionConnectionError(message, response.status, code);
  }
  return payload as T;
}

export async function getNotionConnectionStatus() {
  if (!isNotionConfigured()) return { configured: false, connected: false };

  const user = await notionRequest<JsonRecord>("/users/me");
  const bot = isRecord(user.bot) ? user.bot : null;
  return {
    configured: true,
    connected: true,
    botName: stringValue(user.name) || "Jarvis",
    workspaceName: stringValue(bot?.workspace_name) || null,
  };
}

export async function buildNotionGraph(force = false): Promise<NotionGraph> {
  if (!force && graphCache && graphCache.expiresAt > Date.now()) return graphCache.value;

  const limit = clampNumber(process.env.NOTION_MAX_PAGES, 10, 200, DEFAULT_PAGE_LIMIT);
  const searchResults = await searchSharedContent(limit);
  const pages = searchResults.filter((item): item is NotionPage => item.object === "page");
  const dataSources = searchResults.filter((item): item is NotionDataSource => item.object === "data_source");
  const nodes = searchResults.map(toGraphNode);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = new Map<string, KnowledgeEdge>();

  const addEdge = (
    source: string,
    target: string,
    type: KnowledgeEdge["type"],
    weight = edgeWeight(type),
    reason?: string,
  ) => {
    if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) return;
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${a}:${b}`;
    const existing = edges.get(key);
    if (!existing || weight > (existing.weight ?? 0)) {
      edges.set(key, { source, target, type, weight, reason });
    }
  };

  for (const result of searchResults) {
    const parentId = extractParentId(result.parent);
    if (parentId) addEdge(result.id, parentId, "parent");
    if (result.object === "page") {
      for (const relationId of extractRelationIds(result.properties)) addEdge(result.id, relationId, "relation");
    }
  }

  const contentScanLimit = clampNumber(
    process.env.NOTION_CONTENT_SCAN_LIMIT,
    10,
    limit,
    Math.min(DEFAULT_CONTENT_SCAN_LIMIT, limit),
  );
  const pagesToScan = pages.slice(0, contentScanLimit);
  for (const page of pagesToScan) {
    const blocks = await listBlockChildren(page.id);
    const contentParts: string[] = [];
    for (const block of blocks) {
      contentParts.push(...extractPlainText(block));
      for (const mentionedPageId of extractPageMentions(block)) addEdge(page.id, mentionedPageId, "mention");
      if (block.type === "child_page") addEdge(page.id, block.id, "child");
    }
    const node = nodes.find((candidate) => candidate.id === page.id);
    if (node) {
      node.content = [node.content, ...contentParts]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1800);
    }
  }

  const vectors = buildTfIdfVectors(nodes);
  addSimilarityEdges(nodes, vectors, addEdge);
  const clusterCount = assignSemanticClusters(nodes, vectors);

  const rootNode: KnowledgeNode = {
    id: "jarvis-notion-root",
    label: "Notion",
    group: "System",
    kind: "system",
    x: 0,
    y: 0,
    size: 7,
  };
  nodes.unshift(rootNode);

  const weightedDegree = getWeightedDegree(nodes, [...edges.values()]);
  const rootTargets = [...new Set(nodes.filter((node) => node.kind !== "system").map((node) => node.group))]
    .map((group) => nodes
      .filter((node) => node.group === group)
      .sort((a, b) => (weightedDegree.get(b.id) ?? 0) - (weightedDegree.get(a.id) ?? 0))[0])
    .filter(Boolean);
  for (const target of rootTargets) {
    edges.set(`root:${target.id}`, {
      source: rootNode.id,
      target: target.id,
      type: "root",
      weight: edgeWeight("root"),
    });
  }

  sizeNodes(nodes, [...edges.values()]);
  layoutGraph(nodes);
  const similarityEdgeCount = [...edges.values()].filter((edge) => edge.type === "similarity").length;
  const graph: NotionGraph = {
    nodes,
    edges: [...edges.values()],
    syncedAt: new Date().toISOString(),
    pageCount: pages.length,
    dataSourceCount: dataSources.length,
    contentScannedCount: pagesToScan.length,
    similarityEdgeCount,
    clusterCount,
  };
  graphCache = { value: graph, expiresAt: Date.now() + 2 * 60 * 1000 };
  return graph;
}

async function searchSharedContent(limit: number) {
  const results: NotionSearchResult[] = [];
  let cursor: string | null = null;
  do {
    const response: NotionList<NotionSearchResult> = await notionRequest<NotionList<NotionSearchResult>>("/search", {
      method: "POST",
      body: JSON.stringify({
        page_size: Math.min(100, limit - results.length),
        start_cursor: cursor ?? undefined,
        sort: { direction: "descending", timestamp: "last_edited_time" },
      }),
    });
    results.push(...response.results.filter((item) => item.object === "page" || item.object === "data_source"));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor && results.length < limit);
  return results.slice(0, limit);
}

async function listBlockChildren(blockId: string) {
  const blocks: NotionBlock[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const response = await notionRequest<NotionList<NotionBlock>>(`/blocks/${blockId}/children?${query}`);
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor && blocks.length < 300);
  return blocks;
}

function toGraphNode(item: NotionSearchResult): KnowledgeNode {
  return {
    id: item.id,
    label: extractTitle(item) || "Ohne Titel",
    group: item.object === "data_source" ? "Datenbanken" : extractCategory(item.properties),
    kind: item.object,
    x: 0,
    y: 0,
    size: item.object === "data_source" ? 5.8 : 3.4,
    url: item.url,
    icon: extractIcon(item.icon),
    content: extractPropertyText(item.properties),
    lastEdited: item.last_edited_time,
  };
}

function extractTitle(item: NotionSearchResult) {
  if (item.object === "data_source" && Array.isArray(item.title)) {
    const title = richTextValue(item.title);
    if (title) return title;
  }
  for (const property of Object.values(item.properties ?? {})) {
    if (property.type !== "title" || !Array.isArray(property.title)) continue;
    return richTextValue(property.title as NotionRichText[]);
  }
  return "";
}

function richTextValue(parts: NotionRichText[]) {
  return parts.map((part) => part.plain_text ?? part.text?.content ?? "").join("").trim();
}

function extractCategory(properties?: Record<string, NotionProperty>) {
  const preferredNames = ["bereich", "kategorie", "category", "area", "type", "typ", "fach", "modul"];
  const entries = Object.entries(properties ?? {});
  entries.sort(([a], [b]) => {
    const ai = preferredNames.indexOf(a.toLowerCase());
    const bi = preferredNames.indexOf(b.toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  for (const [, property] of entries) {
    if (property.type === "select" && isRecord(property.select)) {
      const name = stringValue(property.select.name);
      if (name) return name;
    }
    if (property.type === "multi_select" && Array.isArray(property.multi_select)) {
      const first = property.multi_select.find(isRecord);
      const name = first ? stringValue(first.name) : "";
      if (name) return name;
    }
  }
  return "Seiten";
}

function extractRelationIds(properties?: Record<string, NotionProperty>) {
  const ids: string[] = [];
  for (const property of Object.values(properties ?? {})) {
    if (property.type !== "relation" || !Array.isArray(property.relation)) continue;
    for (const relation of property.relation) {
      if (isRecord(relation) && typeof relation.id === "string") ids.push(relation.id);
    }
  }
  return ids;
}

function extractParentId(parent?: JsonRecord) {
  if (!parent) return null;
  for (const key of ["page_id", "data_source_id", "database_id"]) {
    if (typeof parent[key] === "string") return parent[key] as string;
  }
  return null;
}

function extractIcon(icon?: JsonRecord | null) {
  return icon?.type === "emoji" && typeof icon.emoji === "string" ? icon.emoji : undefined;
}

function extractPlainText(value: unknown): string[] {
  const parts: string[] = [];
  walk(value, (candidate) => {
    if (typeof candidate.plain_text === "string" && candidate.plain_text.trim()) parts.push(candidate.plain_text.trim());
  });
  return [...new Set(parts)];
}

function extractPageMentions(value: unknown) {
  const ids = new Set<string>();
  walk(value, (candidate) => {
    if (candidate.type !== "mention" || !isRecord(candidate.mention)) return;
    if (candidate.mention.type !== "page" || !isRecord(candidate.mention.page)) return;
    if (typeof candidate.mention.page.id === "string") ids.add(candidate.mention.page.id);
  });
  return [...ids];
}

function walk(value: unknown, visit: (record: JsonRecord) => void) {
  if (Array.isArray(value)) return void value.forEach((item) => walk(item, visit));
  if (!isRecord(value)) return;
  visit(value);
  Object.values(value).forEach((item) => walk(item, visit));
}

type SparseVector = Map<string, number>;

const STOP_WORDS = new Set([
  "aber", "alle", "allem", "allen", "aller", "alles", "also", "and", "auch", "auf", "aus",
  "bei", "bin", "bis", "bist", "das", "dass", "dein", "deine", "dem", "den", "der", "des",
  "die", "dies", "diese", "ein", "eine", "einem", "einen", "einer", "eines", "für", "from",
  "hat", "ich", "ihre", "ihren", "im", "in", "ist", "mit", "nach", "nicht", "noch", "oder",
  "ohne", "sich", "sie", "sind", "the", "titel", "und", "uns", "von", "vor", "was", "wie",
  "wir", "with", "you", "your", "zum", "zur", "über", "übung", "übungen",
  "seite", "seiten", "datenbank", "datenbanken", "notion",
]);

function extractPropertyText(properties?: Record<string, NotionProperty>) {
  const parts = extractPlainText(properties);
  walk(properties, (candidate) => {
    if (typeof candidate.name === "string" && typeof candidate.color === "string") parts.push(candidate.name);
  });
  return [...new Set(parts)].join(" ").trim().slice(0, 500);
}

function tokenize(text: string) {
  return (text.toLocaleLowerCase("de-DE").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function buildTfIdfVectors(nodes: KnowledgeNode[]) {
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

function addSimilarityEdges(
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

function assignSemanticClusters(nodes: KnowledgeNode[], vectors: SparseVector[]) {
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

function edgeWeight(type: KnowledgeEdge["type"]) {
  if (type === "relation") return 1;
  if (type === "mention") return 0.92;
  if (type === "parent" || type === "child") return 0.82;
  if (type === "root") return 0.42;
  return 0.3;
}

function getWeightedDegree(nodes: KnowledgeNode[], edges: KnowledgeEdge[]) {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    const weight = edge.weight ?? edgeWeight(edge.type);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + weight);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + weight);
  }
  return degree;
}

function sizeNodes(nodes: KnowledgeNode[], edges: KnowledgeEdge[]) {
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

function layoutGraph(nodes: KnowledgeNode[]) {
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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value: string | undefined, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(Math.round(parsed), min, max) : fallback;
}
