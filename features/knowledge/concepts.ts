/** Pure concept normalisation, navigation filtering and alias merging. */

export type ConceptCandidate = {
  name: string;
  description?: string;
  category?: string;
  aliases?: string[];
  importance?: number;
  confidence?: number;
  chunkId: string;
};

export type MergedConcept = {
  id: string;
  label: string;
  normalized: string;
  description: string;
  category: string;
  aliases: string[];
  importance: number;
  occurrences: Array<{ chunkId: string; confidence: number }>;
};

const NAVIGATION_WORDS = new Set([
  "agenda", "aufgabe", "aufgaben", "aufgabenblatt", "assignment", "chapter", "einheit",
  "exercise", "folien", "homework", "inhalt", "inhaltsverzeichnis", "kapitel", "klausur",
  "lecture", "lektion", "lesson", "material", "materialien", "mitschrift", "notes", "notiz",
  "notizen", "ohne titel", "part", "praktikum", "protokoll", "pruefung", "prufung", "prüfung",
  "quiz", "seminar", "session", "sheet", "skript", "slides", "teil", "termin", "tutorial",
  "tutorium", "uebersicht", "uebung", "uebungen", "uebungsblatt", "unit", "unbenannt",
  "untitled", "vorlesung", "week", "woche", "zusammenfassung", "übersicht", "übung", "übungen",
  "übungsblatt",
]);

const NAVIGATION_PATTERN = new RegExp(
  `^(?:[0-9]{1,3}[.)]?\\s*)?(?:${[...NAVIGATION_WORDS].join("|")})(?:\\s*[-–—:]?\\s*[0-9]{1,3})?$`,
  "iu",
);

const ROMAN_PATTERN = /^[ivxlcdm]{1,7}$/iu;

/**
 * Folds unicode, case, hyphen and whitespace variants so that `Reinforcement-Learning`,
 * `reinforcement learning` and `Reinforcement  Learning` become one concept.
 */
export function normalizeConceptName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("de-DE")
    .replace(/[‐-―−_/]/gu, " ")
    .replace(/[’'`´]/gu, "")
    .replace(/[^\p{L}\p{N}+#&. ]/gu, " ")
    .replace(/\.(?=\s|$)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Page and navigation titles must never become map nodes on their own. */
export function isNavigationTitle(value: string) {
  const normalized = normalizeConceptName(value);
  if (!normalized) return true;
  if (/^[0-9]+([.,][0-9]+)*$/u.test(normalized)) return true;
  if (/^[0-9]{1,3}[.)]?$/u.test(normalized)) return true;
  if (NAVIGATION_WORDS.has(normalized)) return true;
  if (NAVIGATION_PATTERN.test(normalized)) return true;
  return false;
}

export function isUsableConceptName(value: string) {
  const normalized = normalizeConceptName(value);
  if (normalized.length < 2 || normalized.length > 64) return false;
  if (!/\p{L}/u.test(normalized)) return false;
  if (normalized.split(" ").length > 6) return false;
  if (ROMAN_PATTERN.test(normalized) && normalized.length <= 3 && !/^(ai|ml|rl|ki)$/iu.test(normalized)) return false;
  return !isNavigationTitle(normalized);
}

export function conceptId(normalized: string) {
  return `concept:${normalized.replace(/\s+/gu, "-")}`;
}

/** Prefers the spelling that carries the most information (case, length, frequency). */
function pickLabel(surfaceForms: Map<string, number>) {
  return [...surfaceForms.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    const casing = (value: string) => (/[A-ZÄÖÜ]/u.test(value) ? 1 : 0);
    if (casing(right[0]) !== casing(left[0])) return casing(right[0]) - casing(left[0]);
    return left[0].localeCompare(right[0], "de");
  })[0][0];
}

/**
 * Merges candidates by normalised name and by explicitly evidenced alias pairs.
 * An alias only merges when a candidate declared it next to its own name.
 */
export function mergeConceptCandidates(candidates: ConceptCandidate[]): MergedConcept[] {
  const aliasTargets = new Map<string, string>();
  for (const candidate of candidates) {
    const normalized = normalizeConceptName(candidate.name);
    if (!isUsableConceptName(candidate.name)) continue;
    for (const alias of candidate.aliases ?? []) {
      const normalizedAlias = normalizeConceptName(alias);
      if (!normalizedAlias || normalizedAlias === normalized) continue;
      if (!isUsableConceptName(alias)) continue;
      if (normalizedAlias.length >= normalized.length) continue;
      if (!aliasTargets.has(normalizedAlias)) aliasTargets.set(normalizedAlias, normalized);
    }
  }

  type Draft = {
    normalized: string;
    surfaceForms: Map<string, number>;
    descriptions: string[];
    categories: Map<string, number>;
    aliases: Set<string>;
    importance: number[];
    occurrences: Map<string, number>;
  };
  const drafts = new Map<string, Draft>();

  for (const candidate of candidates) {
    if (!isUsableConceptName(candidate.name)) continue;
    const rawNormalized = normalizeConceptName(candidate.name);
    const normalized = aliasTargets.get(rawNormalized) ?? rawNormalized;
    const draft = drafts.get(normalized) ?? {
      normalized,
      surfaceForms: new Map<string, number>(),
      descriptions: [],
      categories: new Map<string, number>(),
      aliases: new Set<string>(),
      importance: [],
      occurrences: new Map<string, number>(),
    };
    const label = candidate.name.replace(/\s+/gu, " ").trim();
    if (normalized === rawNormalized) draft.surfaceForms.set(label, (draft.surfaceForms.get(label) ?? 0) + 1);
    else draft.aliases.add(label);
    if (candidate.description?.trim()) draft.descriptions.push(candidate.description.replace(/\s+/gu, " ").trim());
    if (candidate.category?.trim()) {
      const category = candidate.category.replace(/\s+/gu, " ").trim();
      draft.categories.set(category, (draft.categories.get(category) ?? 0) + 1);
    }
    for (const alias of candidate.aliases ?? []) {
      const cleanAlias = alias.replace(/\s+/gu, " ").trim();
      if (cleanAlias && normalizeConceptName(cleanAlias) !== normalized) draft.aliases.add(cleanAlias);
    }
    if (typeof candidate.importance === "number") draft.importance.push(candidate.importance);
    const confidence = typeof candidate.confidence === "number" ? candidate.confidence : 0.6;
    draft.occurrences.set(candidate.chunkId, Math.max(draft.occurrences.get(candidate.chunkId) ?? 0, confidence));
    drafts.set(normalized, draft);
  }

  return [...drafts.values()]
    .filter((draft) => draft.occurrences.size > 0)
    .map((draft): MergedConcept => {
      const label = draft.surfaceForms.size ? pickLabel(draft.surfaceForms) : draft.normalized;
      const category = draft.categories.size
        ? [...draft.categories.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "de"))[0][0]
        : "Allgemein";
      const importance = draft.importance.length
        ? draft.importance.reduce((sum, value) => sum + value, 0) / draft.importance.length
        : 0.5;
      return {
        id: conceptId(draft.normalized),
        label,
        normalized: draft.normalized,
        description: draft.descriptions.sort((left, right) => right.length - left.length)[0] ?? "",
        category,
        aliases: [...draft.aliases].sort((left, right) => left.localeCompare(right, "de")).slice(0, 8),
        importance: Math.min(1, Math.max(0, importance)),
        occurrences: [...draft.occurrences.entries()]
          .map(([chunkId, confidence]) => ({ chunkId, confidence }))
          .sort((left, right) => left.chunkId.localeCompare(right.chunkId)),
      };
    })
    .sort((left, right) => left.normalized.localeCompare(right.normalized, "de"));
}

/**
 * A page title only becomes a concept when the page body actually discusses it.
 * Without that evidence, titles like `5. Übung` would create isolated map nodes.
 */
export function pageTitleHasContentEvidence(title: string, chunkTexts: string[]) {
  const normalized = normalizeConceptName(title);
  if (!normalized || isNavigationTitle(title)) return false;
  return chunkTexts.some((text) => normalizeConceptName(text).includes(normalized));
}
