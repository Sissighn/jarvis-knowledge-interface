import type { GraphPayload, KnowledgeNode, ViewMode } from "../types";

type KnowledgePanelsProps = {
  mode: ViewMode;
  connected: boolean;
  nodeCount: number;
  groups: Array<[string, number]>;
  selectedNode: KnowledgeNode;
  selectedConnections: number;
  graphMeta: Omit<GraphPayload, "nodes" | "edges"> | null;
  onSelectGroup(group: string): void;
};

export function KnowledgePanels({
  mode,
  connected,
  nodeCount,
  groups,
  selectedNode,
  selectedConnections,
  graphMeta,
  onSelectGroup,
}: KnowledgePanelsProps) {
  return (
    <>
      <aside className="index-panel" aria-label="Wissensübersicht">
        <span className="eyebrow">NEURAL INDEX</span>
        <strong>{nodeCount}</strong>
        <span className="index-caption">{connected ? "ECHTE KNOTEN" : "BEISPIELKNOTEN"}</span>
        <div className="index-list">
          {groups.map(([group, count]) => (
            <button key={group} onClick={() => onSelectGroup(group)}><i /> {group} <b>{count}</b></button>
          ))}
        </div>
      </aside>

      <aside className={`context-panel ${mode === "map" ? "is-visible" : ""}`} aria-live="polite">
        <span className="eyebrow">AUSGEWÄHLTER KNOTEN</span>
        <h2>{selectedNode.icon ? <span className="node-icon">{selectedNode.icon}</span> : null}{selectedNode.label}</h2>
        <p>{selectedNode.content || (selectedNode.kind === "system"
          ? `${graphMeta?.clusterCount ?? groups.length} lokale Themencluster mit ${graphMeta?.similarityEdgeCount ?? 0} automatisch erkannten Ähnlichkeiten.`
          : `Verknüpfte Notion-Inhalte und semantische Beziehungen rund um ${selectedNode.label}.`)}</p>
        {selectedNode.keywords?.length ? (
          <div className="keyword-list" aria-label="Erkannte Schlüsselbegriffe">
            {selectedNode.keywords.slice(0, 4).map((keyword) => <span key={keyword}>{keyword}</span>)}
          </div>
        ) : null}
        <div className="context-stats">
          <span><b>{selectedNode.group}</b> Bereich</span>
          <span><b>{String(selectedConnections).padStart(2, "0")}</b> Verbindungen</span>
        </div>
        <button
          className="text-action"
          disabled={!selectedNode.url}
          onClick={() => selectedNode.url && window.open(selectedNode.url, "_blank", "noopener,noreferrer")}
        >
          {selectedNode.url ? "IN NOTION ÖFFNEN" : "LOKALE SYSTEMANSICHT"} <span>↗</span>
        </button>
      </aside>
    </>
  );
}
