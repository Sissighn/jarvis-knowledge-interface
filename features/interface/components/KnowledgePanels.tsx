import { openExternalUrl } from "@/features/desktop/links";
import type { ConceptDetail, ConceptNode, KnowledgeCoverage, SyncProgress, ViewMode } from "../types";

type KnowledgePanelsProps = {
  mode: ViewMode;
  connected: boolean;
  conceptCount: number;
  categories: Array<[string, number]>;
  selectedNode: ConceptNode;
  detail: ConceptDetail | null;
  detailLoading: boolean;
  coverage: KnowledgeCoverage;
  sync: SyncProgress | null;
  onSelectCategory(category: string): void;
};

const NUMBER_FORMAT = new Intl.NumberFormat("de-DE");

const SYNC_LABELS: Record<string, string> = {
  queued: "Sync vorbereitet",
  discovering: "Datenbanken werden gesucht",
  fetching: "Notion-Inhalte werden gelesen",
  indexing: "Konzepte werden aktualisiert",
  embedding: "Semantische Suche wird ergänzt",
  partial: "Teilweise aktualisiert",
  error: "Sync unterbrochen",
  cancelled: "Sync abgebrochen",
  interrupted: "Sync wird fortgesetzt",
};

function groupOccurrences(detail: ConceptDetail | null) {
  const groups = new Map<string, ConceptDetail["occurrences"]>();
  for (const occurrence of detail?.occurrences ?? []) {
    const entries = groups.get(occurrence.rootTitle) ?? [];
    entries.push(occurrence);
    groups.set(occurrence.rootTitle, entries);
  }
  return [...groups.entries()];
}

export function KnowledgePanels({
  mode,
  connected,
  conceptCount,
  categories,
  selectedNode,
  detail,
  detailLoading,
  coverage,
  sync,
  onSelectCategory,
}: KnowledgePanelsProps) {
  const isSystemNode = selectedNode.kind === "system";
  const occurrenceGroups = groupOccurrences(detail);
  const relations = detail?.relations.slice(0, 6) ?? [];
  const syncLabel = sync && !["idle", "ready"].includes(sync.phase) ? SYNC_LABELS[sync.phase] : null;

  return (
    <>
      <aside className="index-panel" aria-label="Wissensübersicht">
        <span className="eyebrow">CONCEPT INDEX</span>
        <strong>{NUMBER_FORMAT.format(conceptCount)}</strong>
        <span className="index-caption">{connected ? "KONZEPTE" : "NICHT VERBUNDEN"}</span>
        <p className="index-coverage">
          {NUMBER_FORMAT.format(coverage.foundSources)} Quellen · {NUMBER_FORMAT.format(coverage.chunks)} Abschnitte
          {" · "}{NUMBER_FORMAT.format(coverage.relations)} Beziehungen
        </p>
        {syncLabel ? (
          <p className="index-sync" aria-live="polite">
            {syncLabel}
            {sync?.totalSources ? ` · Quelle ${sync.processedSources} von ${sync.totalSources}` : ""}
            {sync?.totalDatabases ? ` · Datenbank ${Math.min(sync.processedDatabases + 1, sync.totalDatabases)} von ${sync.totalDatabases}` : ""}
            {sync?.currentSource ? <><br />{sync.currentSource}</> : null}
          </p>
        ) : null}
        <div className="index-list">
          {categories.map(([category, count]) => (
            <button key={category} onClick={() => onSelectCategory(category)}><i /> {category} <b>{count}</b></button>
          ))}
        </div>
      </aside>

      <aside className={`context-panel ${mode === "map" ? "is-visible" : ""}`} aria-live="polite">
        <span className="eyebrow">{isSystemNode ? "WISSENSINDEX" : "AUSGEWÄHLTES KONZEPT"}</span>
        <h2>{selectedNode.label}</h2>
        <p>{isSystemNode
          ? `${NUMBER_FORMAT.format(coverage.concepts)} Konzepte aus ${NUMBER_FORMAT.format(coverage.indexedSources)} indexierten Quellen.`
          : detail?.concept.description || selectedNode.description || "Für diesen Begriff liegt noch keine Kurzdefinition vor."}</p>

        {!isSystemNode && (detail?.concept.aliases.length || selectedNode.aliases.length) ? (
          <div className="keyword-list" aria-label="Aliase">
            {(detail?.concept.aliases ?? selectedNode.aliases).slice(0, 6).map((alias) => <span key={alias}>{alias}</span>)}
          </div>
        ) : null}

        {!isSystemNode ? (
          <div className="context-stats">
            <span><b>{selectedNode.category}</b> Kategorie</span>
            <span><b>{String(detail?.concept.sourceCount ?? selectedNode.sourceCount).padStart(2, "0")}</b> Quellen</span>
            <span><b>{String(detail?.concept.occurrenceCount ?? selectedNode.occurrenceCount).padStart(2, "0")}</b> Fundstellen</span>
          </div>
        ) : null}

        {relations.length ? (
          <section className="concept-relations" aria-label="Wichtigste Beziehungen">
            <span className="eyebrow">BEZIEHUNGEN</span>
            <ul>
              {relations.map((relation) => (
                <li key={`${relation.source}-${relation.target}-${relation.type}`}>
                  <strong>{relation.label}</strong>
                  <small>{relation.reason}{relation.evidenceCount ? ` · ${relation.evidenceCount} Belege` : ""}</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {detailLoading && !detail ? <p className="concept-loading">Fundstellen werden geladen …</p> : null}

        {occurrenceGroups.length ? (
          <section className="concept-occurrences" aria-label="Fundstellen">
            <span className="eyebrow">FUNDSTELLEN</span>
            {occurrenceGroups.map(([rootTitle, occurrences]) => (
              <article key={rootTitle}>
                <h3>{rootTitle} <b>{occurrences.length}</b></h3>
                <ul>
                  {occurrences.slice(0, 8).map((occurrence) => (
                    <li key={`${occurrence.sourceId}-${occurrence.headingPath}-${occurrence.snippet.slice(0, 24)}`}>
                      <strong>{occurrence.sourceTitle}</strong>
                      {occurrence.headingPath ? <small>{occurrence.headingPath}</small> : null}
                      <p>{occurrence.snippet}</p>
                      {occurrence.notionUrl ? (
                        <a
                          href={occurrence.notionUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => {
                            event.preventDefault();
                            void openExternalUrl(occurrence.notionUrl);
                          }}
                        >
                          {occurrence.blockId ? "ZUM BLOCK ↗" : "IN NOTION ÖFFNEN ↗"}
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        ) : null}

        {!isSystemNode && !occurrenceGroups.length && !detailLoading && selectedNode.notionUrl ? (
          <button
            className="text-action"
            onClick={() => void openExternalUrl(selectedNode.notionUrl)}
          >
            IN NOTION ÖFFNEN <span>↗</span>
          </button>
        ) : null}
      </aside>
    </>
  );
}
