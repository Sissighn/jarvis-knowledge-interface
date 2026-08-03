import type { KnowledgeAnswer } from "@/features/knowledge/answer";
import type { KnowledgeNode } from "../types";

type KnowledgeAnswerPanelProps = {
  answer: KnowledgeAnswer;
  connected: boolean;
  nodes: KnowledgeNode[];
  selectedNodeId: string;
  onClose(): void;
  onSelectNode(node: KnowledgeNode): void;
};

export function KnowledgeAnswerPanel({
  answer,
  connected,
  nodes,
  selectedNodeId,
  onClose,
  onSelectNode,
}: KnowledgeAnswerPanelProps) {
  const generated = answer.generation;
  const citedSources = new Set(generated?.citations ?? []);
  const selectNode = (nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (node) onSelectNode(node);
  };

  return (
    <section
      className={`answer-panel status-${answer.status}${generated ? " is-generated" : ""}`}
      aria-live="polite"
      aria-label="Antwort aus dem persönlichen Wissen"
    >
      <header className="answer-header">
        <div>
          <span>{generated
            ? `LOCAL AI · ${generated.model.toUpperCase()}`
            : connected ? "LOKALE NOTION-ANTWORT" : "LOKALE BEISPIELANTWORT"}</span>
          <strong>{answer.title}</strong>
        </div>
        <div className="answer-header-actions">
          <span className="confidence-badge">
            {generated ? "KONTEXT" : answer.confidenceLabel} · {Math.round(answer.confidence * 100)}%
          </span>
          <button type="button" onClick={onClose} aria-label="Antwort schließen">×</button>
        </div>
      </header>

      <p className="answer-question">„{answer.query}“</p>
      <p className="answer-summary">{answer.summary}</p>

      {answer.evidence.length > 0 && (
        <ol className="answer-evidence" aria-label="Belegte Hinweise">
          {answer.evidence.map((evidence, index) => (
            <li key={`${evidence.nodeId}-${index}`}>
              <button type="button" onClick={() => selectNode(evidence.nodeId)}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <p>{evidence.text}</p>
                <small>{evidence.label} · {evidence.group}</small>
              </button>
            </li>
          ))}
        </ol>
      )}

      <p className="answer-caveat">{answer.caveat}</p>

      {answer.sources.length > 0 && (
        <section className="answer-sources" aria-label="Quellen">
          <span>QUELLEN · {answer.sources.length}</span>
          <div>
            {answer.sources.map((source, index) => (
              <article
                className={[
                  selectedNodeId === source.nodeId ? "is-selected" : "",
                  citedSources.has(index + 1) ? "is-cited" : "",
                ].filter(Boolean).join(" ")}
                key={source.nodeId}
              >
                <button type="button" onClick={() => selectNode(source.nodeId)} className="answer-source-button">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{source.label}</strong>
                    <small>
                      {source.group} · {Math.round(source.score * 100)}% MATCH
                      {citedSources.has(index + 1) ? " · BELEGT" : ""}
                    </small>
                  </div>
                </button>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer" aria-label={`${source.label} in Notion öffnen`}>
                    ↗
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
