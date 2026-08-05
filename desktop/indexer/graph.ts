/** Builds the concept map payload from the local index. */
import {
  KNOWLEDGE_ROOT_ID,
  knowledgeRootNode,
  layoutConceptNodes,
  rootEdges,
  sizeConceptNodes,
} from "@/features/knowledge/graph-layout";
import { limitEdgesPerConcept } from "@/features/knowledge/relations";
import type { ConceptEdge, ConceptNode, KnowledgeGraph } from "@/features/knowledge/types";
import type { KnowledgeRepository } from "./db/repository";

export type GraphFilters = {
  databaseIds?: string[];
  /** @deprecated Values are treated as database ids. */
  rootIds?: string[];
  categories?: string[];
};

export function buildKnowledgeGraph(repository: KnowledgeRepository, filters: GraphFilters = {}): KnowledgeGraph {
  const conceptRoots = repository.conceptRootIds();
  const selectedDatabaseIds = repository.selectedDatabaseIds();
  const requestedDatabases = filters.databaseIds?.length ? filters.databaseIds : filters.rootIds;
  const rootFilter = new Set(requestedDatabases?.length ? requestedDatabases : selectedDatabaseIds);
  const categoryFilter = filters.categories?.length ? new Set(filters.categories) : null;

  const nodes: ConceptNode[] = repository.listConcepts()
    .filter((concept) => {
      if (categoryFilter && !categoryFilter.has(concept.category)) return false;
      if (!rootFilter.size) return false;
      const roots = [...(conceptRoots.get(concept.id) ?? [])];
      return roots.some((rootId) => rootFilter.has(rootId));
    })
    .map((concept) => ({
      id: concept.id,
      label: concept.label,
      description: concept.description,
      category: concept.category,
      aliases: concept.aliases,
      importance: concept.importance,
      sourceCount: concept.sourceCount,
      occurrenceCount: concept.occurrenceCount,
      lastSeenAt: concept.lastSeenAt,
      kind: "concept" as const,
      group: concept.category,
      x: 0,
      y: 0,
      size: 3,
      notionUrl: concept.notionUrl ?? undefined,
    }))
    .sort((left, right) => right.importance - left.importance
      || right.sourceCount - left.sourceCount
      || right.occurrenceCount - left.occurrenceCount)
    .slice(0, 100);

  const visibleIds = new Set(nodes.map((node) => node.id));
  const relations = repository.listRelations()
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const edges: ConceptEdge[] = limitEdgesPerConcept(relations);

  const rootNode = knowledgeRootNode();
  const allNodes = [rootNode, ...nodes];
  sizeConceptNodes(allNodes, edges);
  layoutConceptNodes(allNodes);
  const hubEdges = nodes.length ? rootEdges(allNodes, edges) : [];

  return {
    nodes: allNodes,
    edges: [...edges, ...hubEdges],
    categories: [...new Set(nodes.map((node) => node.category))].sort((left, right) => left.localeCompare(right, "de")),
    roots: repository.listDatabases().filter((database) => database.selected).map((database) => ({ id: database.id, title: database.title })),
    coverage: repository.coverage(),
    graphVersion: repository.graphVersion(),
    syncedAt: repository.lastSuccessfulSyncAt(),
  };
}

export { KNOWLEDGE_ROOT_ID };
