/** Pure Notion block helpers: text extraction, heading paths and coverage counting. */

export type NotionRichText = {
  plain_text?: string;
  text?: { content?: string };
  href?: string | null;
  mention?: { type?: string; page?: { id?: string }; database?: { id?: string } };
};

export type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
} & Record<string, unknown>;

const UNSUPPORTED_TYPES = new Set(["image", "video", "audio", "file", "pdf", "embed"]);
const SKIPPED_TYPES = new Set(["divider", "table_of_contents", "breadcrumb", "unsupported", "link_preview"]);
const CONTAINER_TYPES = new Set(["column_list", "column", "synced_block", "table", "template"]);

export function richTextValue(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return (parts as NotionRichText[])
    .map((part) => part?.plain_text ?? part?.text?.content ?? "")
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Collects direct Notion page/database references without treating their labels as concepts. */
export function blockReferences(block: NotionBlock) {
  const references = new Set<string>();
  const payload = blockPayload(block);
  const inspect = (parts: unknown) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts as NotionRichText[]) {
      const id = part.mention?.page?.id ?? part.mention?.database?.id;
      if (id) references.add(id);
    }
  };
  inspect(payload.rich_text);
  inspect(payload.caption);
  if (block.type === "link_to_page") {
    for (const key of ["page_id", "database_id"]) {
      if (typeof payload[key] === "string") references.add(payload[key] as string);
    }
  }
  return [...references];
}

export function isUnsupportedBlock(block: NotionBlock) {
  return UNSUPPORTED_TYPES.has(block.type);
}

export function isContainerBlock(block: NotionBlock) {
  return CONTAINER_TYPES.has(block.type);
}

export function headingLevel(block: NotionBlock) {
  if (block.type === "heading_1") return 1;
  if (block.type === "heading_2") return 2;
  if (block.type === "heading_3") return 3;
  return 0;
}

function blockPayload(block: NotionBlock) {
  const payload = block[block.type];
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

/** Returns the readable text of a single block without descending into children. */
export function blockText(block: NotionBlock): string {
  if (SKIPPED_TYPES.has(block.type) || isUnsupportedBlock(block)) return "";
  const payload = blockPayload(block);

  if (block.type === "table_row") {
    const cells = Array.isArray(payload.cells) ? payload.cells : [];
    return cells.map((cell) => richTextValue(cell)).filter(Boolean).join(" | ");
  }
  if (block.type === "code") {
    const code = richTextValue(payload.rich_text);
    const language = typeof payload.language === "string" ? payload.language : "";
    return code ? `${language ? `${language}: ` : ""}${code}` : "";
  }
  if (block.type === "equation") {
    return typeof payload.expression === "string" ? payload.expression : "";
  }
  if (block.type === "bookmark" || block.type === "link_to_page") {
    const caption = richTextValue(payload.caption);
    const url = typeof payload.url === "string" ? payload.url : "";
    return [caption, url].filter(Boolean).join(" ");
  }
  if (block.type === "child_database" || block.type === "child_page") {
    return typeof payload.title === "string" ? payload.title : "";
  }

  const parts = [richTextValue(payload.rich_text)];
  if (block.type === "callout" || block.type === "to_do") parts.push(richTextValue(payload.caption));
  return parts.filter(Boolean).join(" ").trim();
}

/** Toggles keep their own summary as a heading segment so nested notes stay locatable. */
export function childHeadingPath(block: NotionBlock, headingPath: string[]) {
  const level = headingLevel(block);
  const text = blockText(block);
  if (level > 0) return headingPath.slice(0, level - 1).concat(text || "Abschnitt");
  if (block.type === "toggle" && text) return [...headingPath, text];
  return headingPath;
}

export function nextHeadingPath(block: NotionBlock, headingPath: string[]) {
  const level = headingLevel(block);
  if (level === 0) return headingPath;
  return headingPath.slice(0, level - 1).concat(blockText(block) || "Abschnitt");
}
