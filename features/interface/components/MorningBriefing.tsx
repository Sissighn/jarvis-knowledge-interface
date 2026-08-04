import type { BriefingItem, DailyBriefing, ViewMode } from "../types";

function formatBriefingAge(date: string) {
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 3_600_000));
  if (hours < 1) return "GERADE EBEN";
  if (hours < 24) return `VOR ${hours}H`;
  return `VOR ${Math.floor(hours / 24)}T`;
}

type MorningBriefingProps = {
  mode: ViewMode;
  briefing: DailyBriefing | null;
  loading: boolean;
  error: string | null;
  visibleItems: BriefingItem[];
  savedIds: string[];
  onReload(): void;
  onHide(id: string): void;
  onToggleSaved(id: string): void;
};

export function MorningBriefing({
  mode,
  briefing,
  loading,
  error,
  visibleItems,
  savedIds,
  onReload,
  onHide,
  onToggleSaved,
}: MorningBriefingProps) {
  const renderGroup = (label: string, items: BriefingItem[]) => items.length ? (
    <section className="briefing-group" aria-label={label}>
      <span className="briefing-section-label">{label}</span>
      {items.map((item) => (
        <article className="briefing-card" key={item.id}>
          <div className="briefing-meta">
            <span><i className={`priority-dot ${item.priority}`} />{item.sourceLabel}</span>
            <span>{formatBriefingAge(item.publishedAt)} · {item.score.toFixed(1)}</span>
          </div>
          <h3>{item.title}</h3>
          <p>{item.summary}</p>
          <div className="briefing-topics">
            {item.matchedTopics.slice(0, 2).map((topic) => <span key={topic}>{topic}</span>)}
          </div>
          <div className="briefing-actions">
            <button onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}>ÖFFNEN ↗</button>
            <button className={savedIds.includes(item.id) ? "is-saved" : ""} onClick={() => onToggleSaved(item.id)}>
              {savedIds.includes(item.id) ? "GEMERKT ✓" : "MERKEN"}
            </button>
            <button onClick={() => onHide(item.id)} aria-label={`${item.title} als nicht relevant markieren`}>NICHT RELEVANT</button>
          </div>
        </article>
      ))}
    </section>
  ) : null;

  const importantItems = visibleItems.filter((item) => item.priority === "important");
  const usefulItems = visibleItems.filter((item) => item.priority === "worth_knowing");

  return (
    <aside className={`briefing-panel ${mode === "core" ? "is-visible" : ""}`} aria-live="polite" aria-label="Morning Tech Briefing">
      <header className="briefing-header">
        <div>
          <span className="eyebrow">MORNING TECH BRIEF</span>
          <h2>{briefing?.date ? new Date(`${briefing.date}T12:00:00`).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "short" }) : "Heute"}</h2>
        </div>
        <button className="briefing-refresh" disabled={loading} onClick={onReload} aria-label="Briefing aktualisieren">
          {loading ? "···" : "↻"}
        </button>
      </header>

      <div className="briefing-news-feed">
        {loading && !briefing ? <div className="briefing-loading"><i /><i /><i /><span>QUELLEN WERDEN GEPRÜFT</span></div> : null}
        {error ? <div className="briefing-error"><p>{error}</p><button onClick={onReload}>ERNEUT VERSUCHEN</button></div> : null}
        {briefing && !visibleItems.length && !error ? (
          <div className="briefing-empty"><strong>Heute kein Rauschen.</strong><p>Keine Meldung hat den Relevanzfilter passiert oder du hast alle ausgeblendet.</p></div>
        ) : null}
        {renderGroup("WICHTIG FÜR DICH", importantItems)}
        {renderGroup("WISSENSWERT", usefulItems)}
        {briefing ? (
          <footer className="briefing-sources" title={briefing.sourceStatus.map((status) => `${status.label}: ${status.ok ? `${status.count} geladen` : "nicht erreichbar"}`).join(" · ")}>
            {briefing.sourceStatus.filter((status) => status.ok).length}/{briefing.sourceStatus.length} QUELLEN · MAX. 72H · BIS ZU 10 MELDUNGEN
          </footer>
        ) : null}
      </div>

    </aside>
  );
}
