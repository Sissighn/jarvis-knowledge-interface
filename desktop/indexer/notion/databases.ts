/** Discovery of concrete Notion databases for the local source picker. */
import type { NotionKnowledgeDatabase } from "@/features/knowledge/types";
import type { JsonRecord, NotionClient } from "./client";
import { richTextValue } from "./blocks";
import { entryTitle, parentReference } from "./crawl";

type SearchObject = JsonRecord & {
  object?: string;
  id?: string;
  title?: unknown;
  url?: string;
  parent?: JsonRecord;
  icon?: JsonRecord | null;
  properties?: Record<string, JsonRecord>;
};

function iconValue(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const icon = value as JsonRecord;
  if (icon.type === "emoji" && typeof icon.emoji === "string") return icon.emoji;
  if (icon.type === "external" && icon.external && typeof icon.external === "object") {
    const url = (icon.external as JsonRecord).url;
    return typeof url === "string" ? url : null;
  }
  if (icon.type === "file" && icon.file && typeof icon.file === "object") {
    const url = (icon.file as JsonRecord).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

function objectTitle(value: SearchObject | null) {
  if (!value) return "";
  const title = Array.isArray(value.title) ? richTextValue(value.title) : entryTitle(value);
  return title === "Ohne Titel" ? "" : title;
}

function isGenericDatabaseTitle(title: string) {
  return !title || /^(new database|database|datenbank|ohne titel|untitled)$/iu.test(title.trim());
}

/**
 * Notion 2025+ exposes queryable data sources below stable database objects.
 * We persist the database id and keep every child data-source id as query metadata.
 */
export async function discoverNotionDatabases(client: NotionClient): Promise<NotionKnowledgeDatabase[]> {
  const dataSources = await client.collect<SearchObject>("/search", {
    filter: { property: "object", value: "data_source" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
  });
  const pages = await client.collect<SearchObject>("/search", {
    filter: { property: "object", value: "page" },
  });
  const pagesById = new Map(pages.filter((page) => typeof page.id === "string").map((page) => [page.id as string, page]));
  const grouped = new Map<string, SearchObject[]>();

  for (const dataSource of dataSources) {
    if (dataSource.object !== "data_source" || typeof dataSource.id !== "string") continue;
    const parent = parentReference(dataSource.parent);
    const databaseId = parent.type === "database_id" && parent.id ? parent.id : dataSource.id;
    grouped.set(databaseId, [...(grouped.get(databaseId) ?? []), dataSource]);
  }

  const now = new Date().toISOString();
  const result: NotionKnowledgeDatabase[] = [];
  for (const [databaseId, sources] of grouped) {
    const database = await client.lookup("databases", databaseId) as SearchObject | null;
    const databaseParent = parentReference(database?.parent);
    let parent = databaseParent.id ? pagesById.get(databaseParent.id) ?? null : null;
    if (!parent && databaseParent.id && databaseParent.type === "page_id") {
      parent = await client.lookup("pages", databaseParent.id) as SearchObject | null;
    }
    const originalTitle = objectTitle(database) || objectTitle(sources[0]);
    const parentTitle = objectTitle(parent);
    const title = isGenericDatabaseTitle(originalTitle) && parentTitle ? parentTitle : originalTitle || parentTitle || "Unbenannte Datenbank";
    result.push({
      id: databaseId,
      dataSourceIds: sources.map((source) => source.id as string).sort(),
      title,
      originalTitle: originalTitle || null,
      icon: iconValue(database?.icon) ?? iconValue(parent?.icon) ?? iconValue(sources[0]?.icon),
      parentId: databaseParent.id,
      parentTitle: parentTitle || null,
      url: typeof database?.url === "string" ? database.url : typeof sources[0]?.url === "string" ? sources[0].url : null,
      contentCount: 0,
      selected: false,
      lastSeenAt: now,
    });
  }
  return result.sort((left, right) => left.title.localeCompare(right.title, "de"));
}
