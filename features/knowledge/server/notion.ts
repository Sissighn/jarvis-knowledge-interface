/** Server-only Notion connector and knowledge graph orchestration. */
import type { KnowledgeEdge, KnowledgeNode, NotionGraph } from "../types";
import {
  addSimilarityEdges,
  assignSemanticClusters,
  buildTfIdfVectors,
  edgeWeight,
  getWeightedDegree,
  layoutGraph,
  sizeNodes,
} from "./graph-algorithms";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const DEFAULT_PAGE_LIMIT = 80;
const DEFAULT_CONTENT_SCAN_LIMIT = 40;

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

export async function notionRequest<T>(path: string, init?: RequestInit): Promise<T> {
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
  const contentCharacterLimit = clampNumber(
    process.env.NOTION_CONTENT_CHAR_LIMIT,
    1_800,
    30_000,
    12_000,
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
        .slice(0, contentCharacterLimit);
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

function extractPropertyText(properties?: Record<string, NotionProperty>) {
  const parts = extractPlainText(properties);
  walk(properties, (candidate) => {
    if (typeof candidate.name === "string" && typeof candidate.color === "string") parts.push(candidate.name);
  });
  return [...new Set(parts)].join(" ").trim().slice(0, 500);
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
