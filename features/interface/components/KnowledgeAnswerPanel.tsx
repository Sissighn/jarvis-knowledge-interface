import { openExternalUrl } from "@/features/desktop/links";
import type { KnowledgeAnswer } from "@/features/knowledge/answer";

type KnowledgeAnswerPanelProps = {
  answer: KnowledgeAnswer;
  connected: boolean;
  onClose(): void;
};

export function KnowledgeAnswerPanel({ answer, connected, onClose }: KnowledgeAnswerPanelProps) {
  const generated = answer.generation;
  const citedSources = new Set(generated?.citations ?? []);
  const sourceEntries = answer.sources.map((source, index) => ({ source, citation: index + 1 }));
  const usedSources = generated ? sourceEntries.filter(({ citation }) => citedSources.has(citation)) : sourceEntries;
  const relatedSources = generated ? sourceEntries.filter(({ citation }) => !citedSources.has(citation)) : [];

  const renderAnswer = (text: string) => text.split(/(\[\d+\])/g).map((part, index) => {
    const citation = part.match(/^\[(\d+)\]$/)?.[1];
    const source = citation ? answer.sources[Number(citation) - 1] : undefined;
    if (!source) return <span key={`${part}-${index}`}>{part}</span>;
    return (
      <a
        className="answer-citation"
        key={`${part}-${index}`}
        href={source.notionUrl || undefined}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!source.notionUrl) return;
          event.preventDefault();
          void openExternalUrl(source.notionUrl);
        }}
        aria-label={`Quelle ${citation}: ${source.sourceTitle}`}
        title={`${source.sourceTitle}${source.headingPath ? ` · ${source.headingPath}` : ""}`}
      >
        {part}
      </a>
    );
  });

  const renderSources = (entries: typeof sourceEntries, label: string) => entries.length > 0 && (
    <section className="answer-sources" aria-label={label}>
      <span>{label} · {entries.length}</span>
      <div>
        {entries.map(({ source, citation }) => (
          <article className={citedSources.has(citation) ? "is-cited" : ""} key={source.chunkId}>
            <div className="answer-source-body">
              <span>{String(citation).padStart(2, "0")}</span>
              <div>
                <strong>{source.sourceTitle}</strong>
                <small>
                  {source.rootTitle}{source.headingPath ? ` · ${source.headingPath}` : ""} · {Math.round(source.score * 100)}% MATCH
                  {citedSources.has(citation) ? " · VERWENDET" : ""}
                </small>
                <p>{source.snippet}</p>
              </div>
            </div>
            {source.notionUrl ? (
              <a
                href={source.notionUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalUrl(source.notionUrl);
                }}
                aria-label={`${source.sourceTitle} in Notion öffnen`}
              >
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
            : connected ? "LOKALE INDEX-ANTWORT" : "LOKALE BEISPIELANTWORT"}</span>
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
            <li key={`${evidence.chunkId}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p>{evidence.text}</p>
              <small>{evidence.sourceTitle}{evidence.headingPath ? ` · ${evidence.headingPath}` : ""}</small>
            </li>
          ))}
        </ol>
      )}

      <p className="answer-caveat">{answer.caveat}</p>

      {renderSources(usedSources, generated ? "VERWENDETE ABSCHNITTE" : "FUNDSTELLEN")}
      {renderSources(relatedSources, "WEITERE PASSENDE ABSCHNITTE")}
    </section>
  );
}
