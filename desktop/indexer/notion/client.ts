/** Rate limited, cancellable Notion REST client for the local indexer. */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const MIN_REQUEST_INTERVAL_MS = 340; // At most three requests per second.
const MAX_RETRIES = 4;

export type JsonRecord = Record<string, unknown>;

export type NotionList<T> = {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
};

export class NotionApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
  }
}

export class NotionAbortError extends Error {
  constructor() {
    super("Die Notion-Anfrage wurde abgebrochen.");
    this.name = "NotionAbortError";
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NotionAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NotionAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class NotionClient {
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  /** Set per sync run so cancelling stops in-flight and queued requests. */
  signal?: AbortSignal;

  constructor(private readonly token: string) {}

  private throwIfAborted() {
    if (this.signal?.aborted) throw new NotionAbortError();
  }

  private async takeTurn() {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < MIN_REQUEST_INTERVAL_MS) await wait(MIN_REQUEST_INTERVAL_MS - elapsed, this.signal);
      this.lastRequestAt = Date.now();
    } finally {
      release();
    }
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.token) throw new NotionApiError("Notion ist noch nicht lokal konfiguriert.", 503, "not_configured");

    for (let attempt = 0; ; attempt++) {
      this.throwIfAborted();
      await this.takeTurn();
      let response: Response;
      try {
        response = await fetch(`${NOTION_API_BASE}${path}`, {
          ...init,
          signal: this.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
            ...init?.headers,
          },
        });
      } catch (error) {
        if (this.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw new NotionAbortError();
        if (attempt >= MAX_RETRIES) throw new NotionApiError("Notion ist momentan nicht erreichbar.", 503, "offline");
        await wait(Math.min(8_000, 500 * 2 ** attempt), this.signal);
        continue;
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 2_000;
        if (attempt >= MAX_RETRIES) throw new NotionApiError("Notion drosselt die Anfragen.", 429, "rate_limited");
        await wait(Math.min(delay, 60_000), this.signal);
        continue;
      }

      const payload = await response.json().catch(() => ({})) as JsonRecord;
      if (!response.ok) {
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          await wait(Math.min(8_000, 500 * 2 ** attempt), this.signal);
          continue;
        }
        const message = typeof payload.message === "string"
          ? payload.message
          : "Notion konnte die Anfrage nicht verarbeiten.";
        throw new NotionApiError(message, response.status, typeof payload.code === "string" ? payload.code : undefined);
      }
      return payload as T;
    }
  }

  /** Walks every page of a cursor based endpoint; nothing is truncated. */
  async collect<T>(
    path: string,
    body: JsonRecord | null,
    onPage?: (items: T[]) => void,
  ): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | null = null;
    do {
      const response: NotionList<T> = body
        ? await this.request<NotionList<T>>(path, {
          method: "POST",
          body: JSON.stringify({ ...body, page_size: 100, start_cursor: cursor ?? undefined }),
        })
        : await this.request<NotionList<T>>(
          `${path}${path.includes("?") ? "&" : "?"}page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
        );
      results.push(...response.results);
      onPage?.(response.results);
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return results;
  }

  /** Returns null for objects the integration cannot see instead of failing the crawl. */
  async lookup(kind: "pages" | "databases" | "blocks" | "data_sources", id: string) {
    try {
      return await this.request<JsonRecord>(`/${kind}/${id}`);
    } catch (error) {
      if (error instanceof NotionAbortError) throw error;
      const status = (error as NotionApiError).status;
      if (status === 404 || status === 403 || status === 400) return null;
      throw error;
    }
  }

  async me() {
    return this.request<JsonRecord>("/users/me");
  }
}
