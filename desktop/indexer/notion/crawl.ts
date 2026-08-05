/** Complete Notion traversal: every accessible page below the selected roots. */
import type { SourceBlockText } from "@/features/knowledge/chunking";
import type { NotionClient, JsonRecord } from "./client";
import { blockReferences, blockText, childHeadingPath, isUnsupportedBlock, nextHeadingPath, richTextValue, type NotionBlock } from "./blocks";

export const MAX_BLOCK_DEPTH = 12;
export const MAX_BLOCKS_PER_PAGE = 5_000;

export type NotionEntry = {
  id: string;
  object: "page" | "data_source";
  title: string;
  url: string;
  lastEditedTime: string | null;
  parentId: string | null;
  parentType: string | null;
  icon?: string | null;
  tags?: string[];
  relationIds?: string[];
};

export type PageContent = {
  blocks: SourceBlockText[];
  unsupportedBlocks: number;
  childPageIds: string[];
  truncated: boolean;
  mentionIds: string[];
};

type SearchResult = JsonRecord & {
  object?: string;
  id?: string;
  url?: string;
  last_edited_time?: string;
  parent?: JsonRecord;
  properties?: Record<string, JsonRecord>;
  title?: unknown;
  icon?: JsonRecord | null;
};

export function entryTitle(item: SearchResult) {
  if (Array.isArray(item.title)) {
    const title = richTextValue(item.title);
    if (title) return title;
  }
  for (const property of Object.values(item.properties ?? {})) {
    if (property?.type === "title" && Array.isArray(property.title)) {
      const title = richTextValue(property.title);
      if (title) return title;
    }
  }
  return "Ohne Titel";
}

export function parentReference(parent: unknown): { id: string | null; type: string | null } {
  if (!parent || typeof parent !== "object") return { id: null, type: null };
  const record = parent as JsonRecord;
  const type = typeof record.type === "string" ? record.type : null;
  for (const key of ["page_id", "data_source_id", "database_id", "block_id"]) {
    if (typeof record[key] === "string") return { id: record[key] as string, type };
  }
  return { id: null, type };
}

export function toEntry(item: SearchResult): NotionEntry | null {
  if (item.object !== "page" && item.object !== "data_source") return null;
  if (typeof item.id !== "string") return null;
  const parent = parentReference(item.parent);
  const tags = new Set<string>();
  const relationIds = new Set<string>();
  for (const property of Object.values(item.properties ?? {})) {
    if (property?.type === "multi_select" && Array.isArray(property.multi_select)) {
      for (const option of property.multi_select as JsonRecord[]) if (typeof option.name === "string") tags.add(option.name);
    }
    if ((property?.type === "select" || property?.type === "status") && property[property.type]
      && typeof property[property.type] === "object") {
      const name = (property[property.type] as JsonRecord).name;
      if (typeof name === "string") tags.add(name);
    }
    if (property?.type === "relation" && Array.isArray(property.relation)) {
      for (const related of property.relation as JsonRecord[]) if (typeof related.id === "string") relationIds.add(related.id);
    }
  }
  const icon = item.icon && typeof item.icon === "object" ? item.icon as JsonRecord : null;
  const iconValue = icon?.type === "emoji" && typeof icon.emoji === "string" ? icon.emoji : null;
  return {
    id: item.id,
    object: item.object,
    title: entryTitle(item),
    url: typeof item.url === "string" ? item.url : "",
    lastEditedTime: typeof item.last_edited_time === "string" ? item.last_edited_time : null,
    parentId: parent.id,
    parentType: parent.type,
    icon: iconValue,
    tags: [...tags],
    relationIds: [...relationIds],
  };
}

/** Reads the full `/search` result set; no page limit and no recency cut-off. */
export async function searchAllEntries(client: NotionClient) {
  const results = await client.collect<SearchResult>("/search", {});
  const entries: NotionEntry[] = [];
  for (const item of results) {
    const entry = toEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

export type RootResolution = { rootId: string; parentPath: string[] } | null;

/**
 * Walks the parent chain of an entry and reports which selected root owns it.
 * Blocks act as parents for pages inside toggles, so unknown parents stop the walk.
 */
export function resolveRoot(
  entry: NotionEntry,
  entriesById: Map<string, NotionEntry>,
  selectedRootIds: Set<string>,
): RootResolution {
  const path: string[] = [];
  let current: NotionEntry | undefined = entry;
  let depth = 0;

  while (current && depth <= MAX_BLOCK_DEPTH) {
    if (selectedRootIds.has(current.id)) {
      return { rootId: current.id, parentPath: path.slice(1).reverse() };
    }
    path.push(current.title);
    if (!current.parentId) return null;
    const parent: NotionEntry | undefined = entriesById.get(current.parentId);
    if (!parent) {
      return selectedRootIds.has(current.parentId)
        ? { rootId: current.parentId, parentPath: path.slice(1).reverse() }
        : null;
    }
    current = parent;
    depth += 1;
  }
  return null;
}

/** Database rows are pages too and must be indexed like any other page. */
export async function queryDataSourcePages(client: NotionClient, dataSourceId: string) {
  const results = await client.collect<SearchResult>(`/data_sources/${dataSourceId}/query`, {}).catch(async (error) => {
    const status = (error as { status?: number }).status;
    if (status !== 404 && status !== 400) throw error;
    return client.collect<SearchResult>(`/databases/${dataSourceId}/query`, {});
  });
  return results.map(toEntry).filter((entry): entry is NotionEntry => Boolean(entry));
}

export type ChildFetcher = (blockId: string) => Promise<NotionBlock[]>;

/**
 * Depth-first traversal of every nested block: toggles, columns, lists, tables and
 * synced blocks. Child pages become their own sources instead of inline text.
 */
export async function traverseBlocks(rootBlockId: string, fetchChildren: ChildFetcher): Promise<PageContent> {
  const blocks: SourceBlockText[] = [];
  const childPageIds: string[] = [];
  let unsupportedBlocks = 0;
  let visited = 0;
  let truncated = false;
  const mentionIds = new Set<string>();

  const walk = async (blockId: string, headingPath: string[], depth: number) => {
    if (depth > MAX_BLOCK_DEPTH || visited >= MAX_BLOCKS_PER_PAGE) {
      truncated = truncated || visited >= MAX_BLOCKS_PER_PAGE;
      return;
    }
    const children = await fetchChildren(blockId);
    let path = headingPath;

    for (const block of children) {
      if (visited >= MAX_BLOCKS_PER_PAGE) {
        truncated = true;
        return;
      }
      visited += 1;

      if (block.type === "child_page") {
        childPageIds.push(block.id);
        continue;
      }
      if (isUnsupportedBlock(block)) {
        unsupportedBlocks += 1;
        continue;
      }

      const text = blockText(block);
      for (const reference of blockReferences(block)) mentionIds.add(reference);
      path = nextHeadingPath(block, path);
      if (text && !["heading_1", "heading_2", "heading_3"].includes(block.type)) {
        blocks.push({ blockId: block.id, headingPath: path, text });
      }
      if (block.has_children) {
        await walk(block.id, childHeadingPath(block, path), depth + 1);
      }
    }
  };

  await walk(rootBlockId, [], 0);
  return { blocks, unsupportedBlocks, childPageIds, truncated, mentionIds: [...mentionIds] };
}

export function createChildFetcher(client: NotionClient): ChildFetcher {
  return async (blockId: string) => client.collect<NotionBlock>(`/blocks/${blockId}/children`, null);
}

export async function readPageContent(client: NotionClient, pageId: string) {
  return traverseBlocks(pageId, createChildFetcher(client));
}
