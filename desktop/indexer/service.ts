/** Single local instance of the database-scoped knowledge index. */
import type { KnowledgeStatus, NotionKnowledgeDatabase, NotionStatus } from "@/features/knowledge/types";
import { modelAvailability, pullEmbeddingModel } from "./ai/ollama";
import { databasePath, embeddingModel, notionToken } from "./config";
import { closeKnowledgeDatabase, openKnowledgeDatabase, type KnowledgeDatabase } from "./db/database";
import { KnowledgeRepository } from "./db/repository";
import { NotionClient } from "./notion/client";
import { discoverNotionDatabases } from "./notion/databases";
import { SyncRunner } from "./sync/runner";

const NOTION_STATUS_TTL_MS = 30_000;
const MODEL_STATUS_TTL_MS = 15_000;
const DATABASES_TTL_MS = 5 * 60_000;
type Cached<T> = { value: T; expiresAt: number } | null;

export class KnowledgeService {
  private database: KnowledgeDatabase | null = null;
  private repositoryInstance: KnowledgeRepository | null = null;
  private runnerInstance: SyncRunner | null = null;
  private startupError: string | null = null;
  private notionStatusCache: Cached<NotionStatus> = null;
  private modelStatusCache: Cached<Awaited<ReturnType<typeof modelAvailability>>> = null;
  private databasesRefreshedAt = 0;
  private databasesRefresh: Promise<void> | null = null;
  private pulling = false;
  private pullProgress: string | null = null;

  constructor(private readonly path = databasePath()) {}

  private ensureOpen() {
    if (this.repositoryInstance) return this.repositoryInstance;
    try {
      this.database = openKnowledgeDatabase(this.path);
      this.repositoryInstance = new KnowledgeRepository(this.database);
      this.runnerInstance = new SyncRunner(this.repositoryInstance);
      this.startupError = null;
      return this.repositoryInstance;
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : "Der lokale Index konnte nicht geöffnet werden.";
      throw error;
    }
  }

  get repository() { return this.ensureOpen(); }
  get runner() {
    this.ensureOpen();
    if (!this.runnerInstance) throw new Error("Der lokale Index ist nicht verfügbar.");
    return this.runnerInstance;
  }
  get databaseLocation() { return this.path; }

  close() {
    if (this.database) closeKnowledgeDatabase(this.database);
    this.database = null;
    this.repositoryInstance = null;
    this.runnerInstance = null;
  }

  private notionClient() { return new NotionClient(notionToken()); }

  async notionStatus(): Promise<NotionStatus> {
    if (!notionToken()) return { configured: false, connected: false };
    if (this.notionStatusCache && this.notionStatusCache.expiresAt > Date.now()) return this.notionStatusCache.value;
    try {
      const user = await this.notionClient().me();
      const bot = user.bot && typeof user.bot === "object" ? user.bot as Record<string, unknown> : null;
      const status: NotionStatus = {
        configured: true,
        connected: true,
        botName: typeof user.name === "string" ? user.name : "Jarvis",
        workspaceName: typeof bot?.workspace_name === "string" ? bot.workspace_name : null,
      };
      this.notionStatusCache = { value: status, expiresAt: Date.now() + NOTION_STATUS_TTL_MS };
      return status;
    } catch (error) {
      const status: NotionStatus = { configured: true, connected: false, error: error instanceof Error ? error.message : "Notion ist momentan nicht erreichbar." };
      this.notionStatusCache = { value: status, expiresAt: Date.now() + 5_000 };
      return status;
    }
  }

  private async models() {
    if (this.modelStatusCache && this.modelStatusCache.expiresAt > Date.now()) return this.modelStatusCache.value;
    const value = await modelAvailability();
    this.modelStatusCache = { value, expiresAt: Date.now() + MODEL_STATUS_TTL_MS };
    return value;
  }

  async status(): Promise<KnowledgeStatus> {
    const repository = this.repository;
    const [notion, models] = await Promise.all([this.notionStatus(), this.models()]);
    return {
      available: true,
      notion,
      models: {
        connected: models.connected,
        chatModel: models.chatModel,
        chatModelAvailable: models.chatModelAvailable,
        embeddingModel: models.embeddingModel,
        embeddingModelAvailable: models.embeddingModelAvailable,
        embeddingDimension: repository.embeddingDimension(embeddingModel()),
        pulling: this.pulling,
        pullProgress: this.pullProgress,
        error: models.error,
      },
      sync: this.runner.currentProgress(),
      running: this.runner.isRunning(),
      syncScheduled: this.runner.isScheduled(),
      selectionVersion: repository.selectionVersion(),
      coverage: repository.coverage(),
      graphVersion: repository.graphVersion(),
      lastSuccessfulSyncAt: repository.lastSuccessfulSyncAt(),
      offline: this.runner.isOffline() || (notion.configured && !notion.connected),
      databasePath: this.path,
      error: this.startupError ?? undefined,
    };
  }

  private async refreshDatabases(force = false) {
    if (!notionToken()) return;
    if (!force && this.databasesRefreshedAt + DATABASES_TTL_MS > Date.now()) return;
    if (this.databasesRefresh) return this.databasesRefresh;
    this.databasesRefresh = (async () => {
      const databases = await discoverNotionDatabases(this.notionClient());
      this.repository.replaceDatabases(databases);
      this.repository.migrateAreaSelectionToDatabases();
      this.databasesRefreshedAt = Date.now();
    })().finally(() => { this.databasesRefresh = null; });
    return this.databasesRefresh;
  }

  async availableDatabases(): Promise<NotionKnowledgeDatabase[]> {
    const stored = this.repository.listDatabases();
    if (!notionToken()) return stored;
    if (!stored.length) await this.refreshDatabases(true);
    else void this.refreshDatabases().catch(() => undefined);
    return this.repository.listDatabases();
  }

  async selectDatabases(databaseIds: string[]) {
    const known = new Set(this.repository.listDatabases().map((database) => database.id));
    const selection = [...new Set(databaseIds)].filter((id) => known.has(id));
    const selectionVersion = this.repository.setSelectedDatabases(selection);
    this.repository.bumpGraphVersion();
    const sync = await this.runner.restart("incremental");
    return { databases: this.repository.listDatabases(), selectionVersion, syncScheduled: Boolean(sync.started) };
  }

  async installEmbeddingModel() {
    if (this.pulling) return { started: false as const, reason: "already_running" as const };
    this.pulling = true;
    this.pullProgress = "startet";
    void pullEmbeddingModel((progress) => {
      this.pullProgress = progress.percent === null ? progress.status : `${progress.status} · ${progress.percent} %`;
    }).then(() => { this.pullProgress = "bereit"; })
      .catch((error: unknown) => { this.pullProgress = error instanceof Error ? error.message : "Download fehlgeschlagen"; })
      .finally(() => { this.pulling = false; this.modelStatusCache = null; });
    return { started: true as const };
  }

  resetIndex() {
    this.repository.clearIndex();
    this.databasesRefreshedAt = 0;
    return this.repository.coverage();
  }
}

let instance: KnowledgeService | null = null;
export function knowledgeService() {
  if (!instance) instance = new KnowledgeService();
  return instance;
}
