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
  const sourceEntries = answer.sources.map((source, index) => ({ source, citation: index + 1 }));
  const usedSources = generated ? sourceEntries.filter(({ citation }) => citedSources.has(citation)) : sourceEntries;
  const relatedSources = generated ? sourceEntries.filter(({ citation }) => !citedSources.has(citation)) : [];
  const selectNode = (nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (node) onSelectNode(node);
  };
  const renderAnswer = (text: string) => text.split(/(\[\d+\])/g).map((part, index) => {
    const citation = part.match(/^\[(\d+)\]$/)?.[1];
    const source = citation ? answer.sources[Number(citation) - 1] : undefined;
    if (!source) return <span key={`${part}-${index}`}>{part}</span>;
    return (
      <button
        type="button"
        className="answer-citation"
        key={`${part}-${index}`}
        onClick={() => selectNode(source.nodeId)}
        aria-label={`Quelle ${citation}: ${source.label}`}
        title={source.label}
      >
        {part}
      </button>
    );
  });
  const renderSources = (entries: typeof sourceEntries, label: string) => entries.length > 0 && (
    <section className="answer-sources" aria-label={label}>
      <span>{label} · {entries.length}</span>
      <div>
        {entries.map(({ source, citation }) => (
          <article
            className={[
              selectedNodeId === source.nodeId ? "is-selected" : "",
              citedSources.has(citation) ? "is-cited" : "",
            ].filter(Boolean).join(" ")}
            key={source.nodeId}
          >
            <button type="button" onClick={() => selectNode(source.nodeId)} className="answer-source-button">
              <span>{String(citation).padStart(2, "0")}</span>
              <div>
                <strong>{source.label}</strong>
                <small>
                  {source.group} · {Math.round(source.score * 100)}% MATCH
                  {citedSources.has(citation) ? " · VERWENDET" : ""}
                </small>
                <p>{source.snippet}</p>
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
  );

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
            {generated
              ? `${generated.grounded ? "BELEGT" : "UNSICHER"} · ${citedSources.size} QUELLEN${generated.conversationTurns ? ` · ${generated.conversationTurns} VERLAUF` : ""}`
              : `${answer.confidenceLabel} · ${Math.round(answer.confidence * 100)}%`}
          </span>
          <button type="button" onClick={onClose} aria-label="Antwort schließen">×</button>
        </div>
      </header>

      <p className="answer-question">„{answer.query}“</p>
      <p className="answer-summary">{renderAnswer(answer.summary)}</p>

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

      {renderSources(usedSources, generated ? "VERWENDETE QUELLEN" : "FUNDSTELLEN")}
      {renderSources(relatedSources, "WEITERE PASSENDE NOTIZEN")}
    </section>
  );
}
