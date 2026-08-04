import { NotionConnectionError, notionRequest } from "@/features/knowledge/server/notion";
import type { TechVocabularyTerm, VocabularySaveResult } from "../types";

type NotionRichText = { plain_text?: string };
type NotionBlock = {
  id: string;
  type: string;
  table?: { table_width?: number };
  table_row?: { cells?: NotionRichText[][] };
};
type NotionList<T> = { results: T[]; has_more: boolean; next_cursor: string | null };

const EXPECTED_HEADERS = [
  "Begriff",
  "Kategorie",
  "Kurze Definition",
  "Zweck",
  "Professionelles Beispiel",
  "Einfaches Alltagsbeispiel",
  "Typischer Satz in Gesprächen",
  "Wichtig zu merken",
];

function configuredPageId() {
  return process.env.NOTION_GLOSSARY_PAGE_ID?.trim() ?? "";
}

function configuredTableId() {
  return process.env.NOTION_GLOSSARY_TABLE_BLOCK_ID?.trim() ?? "";
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("de-DE").replace(/\s+/g, " ");
}

function cellText(cell: NotionRichText[] = []) {
  return cell.map((part) => part.plain_text ?? "").join("").trim();
}

async function listBlockChildren(blockId: string) {
  const results: NotionBlock[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = await notionRequest<NotionList<NotionBlock>>(`/blocks/${blockId}/children?${query}`);
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return results;
}

async function inspectTable(tableId: string) {
  const rows = (await listBlockChildren(tableId)).filter((block) => block.type === "table_row");
  const headers = rows[0]?.table_row?.cells?.map(cellText) ?? [];
  const compatible = EXPECTED_HEADERS.every((header, index) => normalize(headers[index] ?? "") === normalize(header));
  const existingTerms = new Set(rows.slice(1).map((row) => normalize(cellText(row.table_row?.cells?.[0]))).filter(Boolean));
  return { compatible, existingTerms };
}

async function resolveTargetTable() {
  const directTableId = configuredTableId();
  if (directTableId) {
    const inspection = await inspectTable(directTableId);
    if (!inspection.compatible) {
      throw new NotionConnectionError("Die konfigurierte Notion-Tabelle hat nicht die erwarteten acht Glossar-Spalten.", 422, "invalid_glossary_table");
    }
    return { id: directTableId, existingTerms: inspection.existingTerms };
  }

  const pageId = configuredPageId();
  if (!pageId) {
    throw new NotionConnectionError("Für das Tech-Glossar ist noch keine Notion-Seite konfiguriert.", 503, "glossary_not_configured");
  }

  const tables = (await listBlockChildren(pageId)).filter((block) => block.type === "table" && block.table?.table_width === 8);
  for (const table of tables.reverse()) {
    const inspection = await inspectTable(table.id);
    if (inspection.compatible) return { id: table.id, existingTerms: inspection.existingTerms };
  }

  throw new NotionConnectionError("Auf der konfigurierten Notion-Seite wurde keine passende Glossar-Tabelle gefunden.", 404, "glossary_table_not_found");
}

function richText(content: string) {
  return [{ type: "text", text: { content: content.slice(0, 1_900) } }];
}

export async function saveVocabularyTermToNotion(term: TechVocabularyTerm): Promise<VocabularySaveResult> {
  const target = await resolveTargetTable();
  if (target.existingTerms.has(normalize(term.term))) {
    return { saved: true, alreadyExists: true, termId: term.id };
  }

  const values = [
    term.term,
    term.category,
    term.definition,
    term.purpose,
    term.professionalExample,
    term.everydayExample,
    term.conversationSentence,
    term.keyTakeaway,
  ];

  await notionRequest(`/blocks/${target.id}/children`, {
    method: "PATCH",
    body: JSON.stringify({
      children: [{
        object: "block",
        type: "table_row",
        table_row: { cells: values.map(richText) },
      }],
    }),
  });

  const pageId = configuredPageId();
  return {
    saved: true,
    alreadyExists: false,
    termId: term.id,
    notionUrl: pageId ? `https://www.notion.so/${pageId.replaceAll("-", "")}` : undefined,
  };
}
