/** Local HTTP contract for `/api/knowledge/*`. Never reachable from a hosted build. */
import { RELATION_LABELS } from "@/features/knowledge/relations";
import type { ConceptDetail, ConceptRelationType } from "@/features/knowledge/types";
import { buildKnowledgeGraph } from "./graph";
import { searchKnowledgeChunks } from "./retrieval";
import { knowledgeService, type KnowledgeService } from "./service";

export const KNOWLEDGE_API_PREFIX = "/api/knowledge";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function failure(message: string, status = 500, code = "index_error") {
  return json({ error: message, code }, status);
}

export function isKnowledgeRequest(pathname: string) {
  return pathname === KNOWLEDGE_API_PREFIX || pathname.startsWith(`${KNOWLEDGE_API_PREFIX}/`);
}

async function readJson(request: Request) {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringList(value: unknown, limit = 200) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(0, limit)
    : [];
}

function queryList(url: URL, key: string) {
  const raw = url.searchParams.get(key);
  return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

export async function handleKnowledgeRequest(
  request: Request,
  service: KnowledgeService = knowledgeService(),
): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.slice(KNOWLEDGE_API_PREFIX.length).replace(/\/$/, "") || "/";
  const method = request.method.toUpperCase();

  try {
    if (route === "/status" && method === "GET") {
      return json(await service.status());
    }

    if (route === "/databases" && method === "GET") {
      const databases = await service.availableDatabases();
      return json({ databases, selectionVersion: service.repository.selectionVersion() });
    }

    if (route === "/databases" && method === "PUT") {
      const body = await readJson(request);
      const result = await service.selectDatabases(stringList(body.selectedDatabaseIds));
      return json({
        databases: result.databases,
        selectionVersion: result.selectionVersion,
        sync: { scheduled: result.syncScheduled, phase: service.runner.currentProgress().phase },
      });
    }

    if (route === "/sync" && method === "POST") {
      const body = await readJson(request);
      const mode = body.mode === "full" ? "full" : "incremental";
      const result = await service.runner.start(mode);
      if (!result.started && result.reason === "already_running") {
        return failure("Es läuft bereits eine Synchronisierung.", 409, "already_running");
      }
      if (!result.started && result.reason === "not_configured") {
        return failure("Notion ist noch nicht lokal konfiguriert.", 503, "not_configured");
      }
      return json({ started: true, mode, sync: service.runner.currentProgress() });
    }

    if (route === "/sync/cancel" && method === "POST") {
      return json({ cancelled: service.runner.cancel() });
    }

    if (route === "/sync/restart" && method === "POST") {
      const body = await readJson(request);
      const result = await service.runner.restart(body.mode === "full" ? "full" : "incremental");
      return json({ started: Boolean(result.started), scheduled: service.runner.isScheduled() });
    }

    if (route === "/graph" && method === "GET") {
      return json(buildKnowledgeGraph(service.repository, {
        databaseIds: queryList(url, "databases"),
        categories: queryList(url, "categories"),
      }));
    }

    if (route.startsWith("/concepts/") && method === "GET") {
      const conceptId = decodeURIComponent(route.slice("/concepts/".length));
      const repository = service.repository;
      const concept = repository.getConcept(conceptId);
      if (!concept) return failure("Dieses Konzept ist nicht im lokalen Index.", 404, "not_found");
      const labels = new Map(repository.listConcepts().map((entry) => [entry.id, entry.label]));
      const detail: ConceptDetail = {
        concept: {
          id: concept.id,
          label: concept.label,
          description: concept.description,
          category: concept.category,
          aliases: concept.aliases,
          importance: concept.importance,
          sourceCount: concept.sourceCount,
          occurrenceCount: concept.occurrenceCount,
          lastSeenAt: concept.lastSeenAt,
          kind: "concept",
          group: concept.category,
          x: 0,
          y: 0,
          size: 3,
          notionUrl: concept.notionUrl ?? undefined,
        },
        relations: repository.listRelationsForConcept(conceptId)
          .sort((left, right) => right.weight - left.weight)
          .map((edge) => ({
            ...edge,
            label: `${RELATION_LABELS[edge.type as ConceptRelationType] ?? edge.type}: ${
              labels.get(edge.source === conceptId ? edge.target : edge.source) ?? "Unbekannt"
            }`,
          })),
        occurrences: repository.listOccurrences(conceptId),
      };
      return json(detail);
    }

    if (route === "/search" && method === "POST") {
      const body = await readJson(request);
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query || query.length > 500) return failure("Die Frage ist leer oder zu lang.", 400, "invalid_query");
      return json(await searchKnowledgeChunks(service.repository, query, {
        previousQueries: stringList(body.previousQueries, 4),
        preferredSourceIds: stringList(body.preferredSourceIds, 8),
      }));
    }

    if (route === "/models/install" && method === "POST") {
      const result = await service.installEmbeddingModel();
      if (!result.started) return failure("Der Download läuft bereits.", 409, "already_running");
      return json({ started: true });
    }

    if (route === "/reset" && method === "POST") {
      return json({ reset: true, coverage: service.resetIndex() });
    }

    return failure("Unbekannter Index-Endpunkt.", 404, "not_found");
  } catch (error) {
    const status = (error as { status?: number }).status;
    return failure(
      error instanceof Error ? error.message : "Der lokale Index hat die Anfrage nicht verarbeitet.",
      typeof status === "number" && status >= 400 && status < 600 ? status : 500,
    );
  }
}
