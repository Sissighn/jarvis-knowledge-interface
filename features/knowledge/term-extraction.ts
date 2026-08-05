/** Fast, deterministic DE/EN concept extraction for the local Notion index. */
import { conceptId, isUsableConceptName, normalizeConceptName } from "./concepts";

export type TermChunk = {
  id: string;
  sourceId: string;
  sourceTitle: string;
  databaseTitle: string;
  headingPath: string;
  text: string;
};

export type ExtractedConcept = {
  id: string;
  label: string;
  normalized: string;
  aliases: string[];
  description: string;
  category: string;
  importance: number;
  occurrences: Array<{ chunkId: string; sourceId: string; snippet: string; confidence: number }>;
};

const STOP_WORDS = new Set(`aber als also am an auch auf aus bei bis da dadurch daher darum das dass dein deine dem den der deren des die dies diese doch dort durch ein eine einem einen einer eines er es für gegen hat hier ich im in ins ist ja jede jeder jedes kann kein keine man mit nach nicht noch nur ob oder ohne sehr sich sie sind so über um und uns unter vom von vor war was weil wenn wie wird wo zu zum zur
a about after again against all also am an and any are as at be because been before being between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves
abschnitt beispiel beispiele datum definition einführung ende ergebnis fazit frage fragen grundlagen hinweis inhalt kurs lernziel material methode modul notiz seite thema themen titel übersicht übung übungen zusammenfassung chapter exercise lecture lesson notes page section summary topic unit week`.split(/\s+/u));

const GENERIC_PATTERNS = [
  /^\d+(?:[.,]\d+)*$/u,
  /^(?:teil|part|woche|week|kapitel|chapter|übung|exercise)\s+\d+$/iu,
  /^(?:neue?|weitere?|wichtige?|verschiedene?|folgende?)\s+/iu,
];

type Candidate = {
  normalized: string;
  surfaces: Map<string, number>;
  sources: Set<string>;
  chunks: Map<string, { sourceId: string; text: string; heading: boolean; count: number }>;
  databaseTitles: Map<string, number>;
  headingHits: number;
  distinctive: boolean;
  tokenCount: number;
  total: number;
};

function tokens(value: string) {
  return value.match(/[\p{L}][\p{L}\p{N}+#.-]*/gu) ?? [];
}

function distinctiveSurface(value: string) {
  return /[A-ZÄÖÜ]{2,}/u.test(value)
    || /[a-zäöü][A-ZÄÖÜ]/u.test(value)
    || /[+#.]|\d/u.test(value)
    || value.split(/\s+/u).length >= 2 && value.split(/\s+/u).some((word) => /^[A-ZÄÖÜ]/u.test(word));
}

function validPhrase(parts: string[]) {
  const phrase = parts.join(" ").replace(/\s+/gu, " ").trim();
  const normalized = normalizeConceptName(phrase);
  if (!isUsableConceptName(phrase) || GENERIC_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  const normalizedParts = normalized.split(" ");
  if (normalizedParts.every((part) => STOP_WORDS.has(part))) return false;
  if (STOP_WORDS.has(normalizedParts[0]) || STOP_WORDS.has(normalizedParts.at(-1) ?? "")) return false;
  if (parts.length === 1 && !distinctiveSurface(phrase) && normalized.length < 6) return false;
  return true;
}

function categoryFor(label: string, databaseTitles: Map<string, number>) {
  const value = `${label} ${[...databaseTitles.keys()].join(" ")}`.toLocaleLowerCase("de-DE");
  if (/\b(ai|ki|machine|learning|neural|llm|transformer|reinforcement|supervised|unsupervised|modell)\b/u.test(value)) return "AI & Machine Learning";
  if (/\b(database|datenbank|sql|data|analytics|statistik|probability)\b/u.test(value)) return "Data";
  if (/\b(security|sicherheit|privacy|krypt|auth|attack|malware)\b/u.test(value)) return "Security";
  if (/\b(cloud|docker|kubernetes|devops|deployment|ci\/cd|terraform)\b/u.test(value)) return "Cloud & DevOps";
  if (/\b(code|coding|software|typescript|javascript|python|java|react|api|algorithm)\b/u.test(value)) return "Softwareentwicklung";
  const bestDatabase = [...databaseTitles.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  return bestDatabase || "Allgemein";
}

function snippet(text: string, label: string) {
  const clean = text.replace(/\s+/gu, " ").trim();
  const index = clean.toLocaleLowerCase("de-DE").indexOf(label.toLocaleLowerCase("de-DE"));
  const start = Math.max(0, index < 0 ? 0 : index - 90);
  const end = Math.min(clean.length, index < 0 ? 220 : index + label.length + 150);
  return `${start ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

/** Returns at most `limit` concepts, each backed by one or more real chunks. */
export function extractCorpusConcepts(chunks: TermChunk[], limit = 100): ExtractedConcept[] {
  const candidates = new Map<string, Candidate>();
  const sourceCount = new Set(chunks.map((chunk) => chunk.sourceId)).size || 1;

  for (const chunk of chunks) {
    const heading = chunk.headingPath.trim();
    const fields = [{ text: chunk.text, heading: false }, ...(heading ? [{ text: heading, heading: true }] : [])];
    for (const field of fields) {
      const words = tokens(field.text).slice(0, 900);
      for (let start = 0; start < words.length; start++) {
        for (let length = 1; length <= 4 && start + length <= words.length; length++) {
          const parts = words.slice(start, start + length);
          if (!validPhrase(parts)) continue;
          const surface = parts.join(" ");
          const normalized = normalizeConceptName(surface);
          const candidate = candidates.get(normalized) ?? {
            normalized,
            surfaces: new Map(),
            sources: new Set(),
            chunks: new Map(),
            databaseTitles: new Map(),
            headingHits: 0,
            distinctive: false,
            tokenCount: length,
            total: 0,
          };
          candidate.surfaces.set(surface, (candidate.surfaces.get(surface) ?? 0) + 1);
          candidate.sources.add(chunk.sourceId);
          const occurrence = candidate.chunks.get(chunk.id) ?? { sourceId: chunk.sourceId, text: chunk.text, heading: false, count: 0 };
          occurrence.count += 1;
          occurrence.heading ||= field.heading;
          candidate.chunks.set(chunk.id, occurrence);
          candidate.databaseTitles.set(chunk.databaseTitle, (candidate.databaseTitles.get(chunk.databaseTitle) ?? 0) + 1);
          candidate.headingHits += field.heading ? 1 : 0;
          candidate.distinctive ||= distinctiveSurface(surface);
          candidate.total += 1;
          candidates.set(normalized, candidate);
        }
      }
    }
  }

  const scored = [...candidates.values()].map((candidate) => {
    const df = candidate.sources.size;
    const idf = Math.log((sourceCount + 1) / (df + 0.5)) + 1;
    const score = Math.log1p(candidate.total) * idf
      + Math.min(2.4, candidate.headingHits * 0.35)
      + (candidate.tokenCount - 1) * 0.42
      + (candidate.distinctive ? 0.7 : 0)
      + Math.min(1.5, df * 0.12);
    return { candidate, score };
  }).filter(({ candidate, score }) => {
    if (candidate.sources.size >= 2) return score >= 1.8;
    return candidate.distinctive && (candidate.total >= 2 || candidate.headingHits > 0) && score >= 2.2;
  });

  const sourceQuota = new Map<string, number>();
  const selected: Array<{ candidate: Candidate; score: number }> = [];
  for (const entry of scored.sort((left, right) => right.score - left.score || left.candidate.normalized.localeCompare(right.candidate.normalized, "de"))) {
    if (selected.length >= limit) break;
    const eligible = [...entry.candidate.sources].some((sourceId) => (sourceQuota.get(sourceId) ?? 0) < 40);
    if (!eligible) continue;
    selected.push(entry);
    for (const sourceId of entry.candidate.sources) sourceQuota.set(sourceId, (sourceQuota.get(sourceId) ?? 0) + 1);
  }

  const maxScore = selected[0]?.score ?? 1;
  return selected.map(({ candidate, score }) => {
    const surfaces = [...candidate.surfaces.entries()].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length);
    const label = surfaces[0]?.[0] ?? candidate.normalized;
    const occurrences = [...candidate.chunks.entries()].map(([chunkId, occurrence]) => ({
      chunkId,
      sourceId: occurrence.sourceId,
      snippet: snippet(occurrence.text, label),
      confidence: Math.min(0.98, 0.5 + Math.log1p(occurrence.count) * 0.12 + (occurrence.heading ? 0.12 : 0)),
    }));
    const first = occurrences[0]?.snippet ?? "";
    return {
      id: conceptId(candidate.normalized),
      label,
      normalized: candidate.normalized,
      aliases: surfaces.slice(1, 7).map(([surface]) => surface),
      description: first,
      category: categoryFor(label, candidate.databaseTitles),
      importance: Math.max(0.2, Math.min(1, score / maxScore)),
      occurrences,
    };
  });
}
