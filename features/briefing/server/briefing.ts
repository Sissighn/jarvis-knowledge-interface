/** Server-only aggregation and relevance ranking for the daily briefing. */
import { buildDailyTechVocabulary } from "@/features/glossary/daily";
import type { BriefingItem, BriefingSource, BriefingSourceStatus, DailyBriefing } from "../types";

type Candidate = Omit<BriefingItem, "id" | "score" | "priority" | "topics" | "matchedTopics"> & {
  sourceSignal?: number;
};

type Topic = { label: string; keywords: string[]; weight: number };

const TECHPRESSO_API = "https://cms.dupple.com/api/newsletter-archives?where%5Bnewsletter%5D%5Bequals%5D=techpresso&sort=-publishedDate&limit=2";
const GITHUB_FEED = "https://github.blog/changelog/feed/";
const OPENAI_FEED = "https://openai.com/news/rss.xml";
const HN_API = "https://hacker-news.firebaseio.com/v0";
const CACHE_TTL_MS = 45 * 60 * 1000;
export const MAX_BRIEFING_AGE_HOURS = 72;

const TOPICS: Topic[] = [
  { label: "AI & ML", weight: 2.1, keywords: ["artificial intelligence", "machine learning", "language model", "neural", "reasoning", "inference", "training", "multimodal", "foundation model", "model family", "openai", "anthropic", "deepmind", "gemini", "gpt-", " llm", " ai ", " ai-"] },
  { label: "Coding Agents", weight: 2.5, keywords: ["codex", "claude code", "coding agent", "agentic coding", "software agent", "mcp", "developer agent", "vibe coding", "computer use"] },
  { label: "Developer Tools", weight: 1.8, keywords: ["github", "visual studio code", "vs code", "typescript", "javascript", "react", "next.js", "vite", "python", "developer tool", "copilot", " api ", "open source"] },
  { label: "Local AI", weight: 2.2, keywords: ["local ai", "on-device", "apple silicon", "ollama", "quantized", "quantization", "small model", "edge model"] },
  { label: "Knowledge & Workflow", weight: 2, keywords: ["notion", "obsidian", "knowledge management", "productivity", "automation", "workflow", "second brain"] },
];

const NEGATIVE_KEYWORDS = [
  "funding round", "raises $", "valuation", "layoffs", "bitcoin", "cryptocurrency",
  "smartphone", "iphone", "gadget", "advertising", "earnings call",
];

const SOURCE_BASE_SCORE: Record<BriefingSource, number> = {
  techpresso: 2.25,
  github: 2.8,
  openai: 2.8,
  hackernews: 1.25,
};

const SOURCE_LABEL: Record<BriefingSource, string> = {
  techpresso: "Techpresso",
  github: "GitHub Changelog",
  openai: "OpenAI News",
  hackernews: "Hacker News",
};

const SOURCE_PRIORITY: Record<BriefingSource, number> = {
  openai: 4,
  github: 4,
  techpresso: 3,
  hackernews: 2,
};

let memoryCache: { createdAt: number; value: DailyBriefing } | null = null;

function decodeEntities(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(value: string) {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(value: string, max = 210) {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, Math.max(lastSpace, max * 0.72))}…`;
}

async function fetchText(url: string, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "JARVIS-local-briefing/0.1" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function findHref(value: string) {
  const match = value.match(/href\s*=\s*["']([^"']+)["']/i);
  return match ? decodeEntities(match[1]) : "";
}

function firstMeaningfulListItem(value: string) {
  const items = [...value.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => cleanText(match[1]))
    .filter((text) => text.length >= 35);
  if (items.length) return items[0];
  const paragraph = value.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return paragraph ? cleanText(paragraph[1]) : "";
}

async function fetchTechpresso(): Promise<Candidate[]> {
  const raw = await fetchText(TECHPRESSO_API);
  const payload = JSON.parse(raw) as {
    docs?: Array<{ title?: string; slug?: string; excerpt?: string; htmlContent?: string; publishedDate?: string }>;
  };
  const candidates: Candidate[] = [];

  for (const issue of payload.docs ?? []) {
    const html = issue.htmlContent ?? "";
    const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
    for (let index = 0; index < headings.length; index++) {
      const match = headings[index];
      const headingHtml = match[1];
      const title = cleanText(headingHtml.replace(/<a[\s\S]*?<\/a>/gi, ""));
      if (!title || /other news|tools|papers|sponsor|techpresso/i.test(title)) continue;
      const start = (match.index ?? 0) + match[0].length;
      const end = headings[index + 1]?.index ?? html.length;
      const section = html.slice(start, end);
      const url = findHref(headingHtml) || findHref(section) || `https://techpresso.co/archives/${issue.slug ?? ""}`;
      const summary = firstMeaningfulListItem(section);
      if (title.length < 10 || summary.length < 25 || !url.startsWith("http")) continue;
      candidates.push({
        title: shorten(title, 150),
        summary: shorten(summary),
        url,
        source: "techpresso",
        sourceLabel: SOURCE_LABEL.techpresso,
        publishedAt: issue.publishedDate ?? new Date().toISOString(),
      });
    }
  }
  return candidates.slice(0, 22);
}

function extractXmlTag(block: string, tag: string) {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  return expression.exec(block)?.[1] ?? "";
}

function parseRss(xml: string, source: "github" | "openai"): Candidate[] {
  const blocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  return blocks.slice(0, 24).flatMap((block) => {
    const title = cleanText(extractXmlTag(block, "title"));
    const url = cleanText(extractXmlTag(block, "link"));
    const date = cleanText(extractXmlTag(block, "pubDate")) || cleanText(extractXmlTag(block, "dc:date"));
    const description = cleanText(extractXmlTag(block, "description") || extractXmlTag(block, "content:encoded"));
    if (!title || !url.startsWith("http")) return [];
    return [{
      title: shorten(title, 150),
      summary: shorten(description || `${SOURCE_LABEL[source]} hat eine neue Meldung veröffentlicht.`),
      url,
      source,
      sourceLabel: SOURCE_LABEL[source],
      publishedAt: Number.isNaN(Date.parse(date)) ? new Date().toISOString() : new Date(date).toISOString(),
    } satisfies Candidate];
  });
}

async function fetchRss(source: "github" | "openai") {
  return parseRss(await fetchText(source === "github" ? GITHUB_FEED : OPENAI_FEED), source);
}

type HackerNewsItem = { id: number; type?: string; title?: string; url?: string; time?: number; score?: number; descendants?: number };

async function fetchHackerNews(): Promise<Candidate[]> {
  const ids = JSON.parse(await fetchText(`${HN_API}/topstories.json`)) as number[];
  const rows = await Promise.allSettled(ids.slice(0, 24).map(async (id) => {
    const item = JSON.parse(await fetchText(`${HN_API}/item/${id}.json`, 4000)) as HackerNewsItem;
    return item;
  }));
  return rows.flatMap((row) => {
    if (row.status !== "fulfilled") return [];
    const item = row.value;
    if (item.type !== "story" || !item.title || !item.url || !item.time) return [];
    return [{
      title: shorten(item.title, 150),
      summary: `${item.score ?? 0} Punkte · ${item.descendants ?? 0} Kommentare auf Hacker News`,
      url: item.url,
      source: "hackernews",
      sourceLabel: SOURCE_LABEL.hackernews,
      publishedAt: new Date(item.time * 1000).toISOString(),
      sourceSignal: Math.min(1.2, Math.log10(Math.max(item.score ?? 1, 1)) * 0.55),
    } satisfies Candidate];
  });
}

function searchable(candidate: Candidate) {
  return ` ${candidate.title} ${candidate.summary} ${candidate.sourceLabel} `.toLocaleLowerCase("en");
}

export function briefingAgeHours(publishedAt: string, now = Date.now()) {
  const timestamp = Date.parse(publishedAt);
  if (Number.isNaN(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - timestamp) / 3_600_000);
}

export function isBriefingFresh(publishedAt: string, now = Date.now()) {
  return briefingAgeHours(publishedAt, now) <= MAX_BRIEFING_AGE_HOURS;
}

function scoreCandidate(candidate: Candidate) {
  const text = searchable(candidate);
  const matchedTopics = TOPICS.filter((topic) => topic.keywords.some((keyword) => text.includes(keyword)));
  const topicScore = matchedTopics.reduce((sum, topic) => sum + topic.weight, 0);
  const negativeScore = NEGATIVE_KEYWORDS.filter((keyword) => text.includes(keyword)).length * 1.5;
  const ageHours = briefingAgeHours(candidate.publishedAt);
  const freshness = ageHours <= 6 ? 3 : ageHours <= 12 ? 2.7 : ageHours <= 24 ? 2.2 : ageHours <= 48 ? 1.15 : 0.2;
  const raw = SOURCE_BASE_SCORE[candidate.source] + topicScore + freshness + (candidate.sourceSignal ?? 0) - negativeScore;
  return {
    score: Math.max(0, Math.min(10, Math.round(raw * 10) / 10)),
    matchedTopics: matchedTopics.map((topic) => topic.label),
    ageHours,
  };
}

function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function titleTokens(value: string) {
  return new Set(value.toLowerCase().replace(/[^a-z0-9äöüß ]/g, " ").split(/\s+/).filter((token) => token.length > 2));
}

function titleSimilarity(a: string, b: string) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function stableId(candidate: Candidate) {
  const value = `${candidate.source}:${normalizeUrl(candidate.url)}:${candidate.title}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `brief-${(hash >>> 0).toString(36)}`;
}

function rankAndDeduplicate(candidates: Candidate[]) {
  const scored = candidates
    .map((candidate) => ({ candidate, ...scoreCandidate(candidate) }))
    .filter((entry) => entry.ageHours <= MAX_BRIEFING_AGE_HOURS && entry.matchedTopics.length > 0 && entry.score >= 5.2)
    .sort((a, b) => b.score - a.score
      || Date.parse(b.candidate.publishedAt) - Date.parse(a.candidate.publishedAt)
      || SOURCE_PRIORITY[b.candidate.source] - SOURCE_PRIORITY[a.candidate.source]);
  const chosen: typeof scored = [];
  for (const entry of scored) {
    const duplicateIndex = chosen.findIndex((other) =>
      normalizeUrl(other.candidate.url) === normalizeUrl(entry.candidate.url)
      || titleSimilarity(other.candidate.title, entry.candidate.title) >= 0.58,
    );
    if (duplicateIndex === -1) {
      chosen.push(entry);
      continue;
    }
    const existing = chosen[duplicateIndex];
    if (SOURCE_PRIORITY[entry.candidate.source] > SOURCE_PRIORITY[existing.candidate.source]) {
      chosen[duplicateIndex] = { ...entry, score: Math.max(entry.score, existing.score) };
    }
  }
  return chosen
    .sort((a, b) => {
      const scoreDifference = b.score - a.score;
      if (Math.abs(scoreDifference) > 0.6) return scoreDifference;
      return Date.parse(b.candidate.publishedAt) - Date.parse(a.candidate.publishedAt);
    })
    .slice(0, 10)
    .map(({ candidate, score, matchedTopics, ageHours }) => ({
      ...candidate,
      id: stableId(candidate),
      score,
      priority: score >= 7 && ageHours <= 36 ? "important" as const : "worth_knowing" as const,
      topics: matchedTopics,
      matchedTopics,
    }));
}

function localDate() {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function buildDailyBriefing(force = false): Promise<DailyBriefing> {
  if (!force && memoryCache && Date.now() - memoryCache.createdAt < CACHE_TTL_MS) return memoryCache.value;

  const sourceJobs: Array<{ source: BriefingSource; run: () => Promise<Candidate[]> }> = [
    { source: "techpresso", run: fetchTechpresso },
    { source: "github", run: () => fetchRss("github") },
    { source: "openai", run: () => fetchRss("openai") },
    { source: "hackernews", run: fetchHackerNews },
  ];
  const settled = await Promise.allSettled(sourceJobs.map((job) => job.run()));
  const candidates: Candidate[] = [];
  const sourceStatus: BriefingSourceStatus[] = settled.map((result, index) => {
    const source = sourceJobs[index].source;
    if (result.status === "fulfilled") {
      candidates.push(...result.value);
      return { source, label: SOURCE_LABEL[source], ok: true, count: result.value.length };
    }
    return {
      source,
      label: SOURCE_LABEL[source],
      ok: false,
      count: 0,
      error: result.reason instanceof Error ? result.reason.message : "Quelle nicht erreichbar",
    };
  });

  if (!sourceStatus.some((status) => status.ok)) throw new Error("Keine Briefing-Quelle ist momentan erreichbar.");
  const items = rankAndDeduplicate(candidates);
  const date = localDate();
  const value: DailyBriefing = {
    date,
    generatedAt: new Date().toISOString(),
    items,
    sourceStatus,
    vocabulary: buildDailyTechVocabulary(date),
  };
  memoryCache = { createdAt: Date.now(), value };
  return value;
}
