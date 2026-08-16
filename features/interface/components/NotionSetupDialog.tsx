"use client";

import { useEffect, useMemo, useState } from "react";
import { openExternalUrl } from "@/features/desktop/links";
import type { KnowledgeCoverage, KnowledgeStatus, NotionKnowledgeDatabase, NotionStatus } from "../types";

type Props = {
  notionStatus: NotionStatus;
  status: KnowledgeStatus | null;
  coverage: KnowledgeCoverage;
  databases: NotionKnowledgeDatabase[];
  databasesLoading: boolean;
  savingSelection: boolean;
  selectionSavedAt: number | null;
  indexAvailable: boolean;
  error: string | null;
  onClose(): void;
  /** Async on purpose: the declared Promise stops it being returned from an effect. */
  onLoadDatabases(): Promise<void>;
  onSaveDatabases(databaseIds: string[]): void;
  onSync(mode: "incremental" | "full"): void;
  onCancelSync(): void;
  onInstallEmbeddingModel(): void;
  onResetIndex(): void;
};

const NUMBER = new Intl.NumberFormat("de-DE");
const PHASE_LABEL: Record<string, string> = {
  idle: "BEREIT",
  queued: "WIRD VORBEREITET",
  discovering: "DATENBANKEN WERDEN GESUCHT",
  fetching: "NOTION-INHALTE WERDEN GELESEN",
  indexing: "KONZEPTE UND VERBINDUNGEN WERDEN AKTUALISIERT",
  embedding: "SEMANTISCHE SUCHE WIRD ERGÄNZT",
  ready: "BEREIT",
  partial: "TEILWEISE AKTUALISIERT",
  error: "FEHLER",
  cancelled: "ABGEBROCHEN",
  interrupted: "UNTERBROCHEN",
};

function DatabaseIcon({ value }: { value: string | null }) {
  if (!value) return <span className="database-icon fallback">◇</span>;
  // Notion icon URLs are short-lived and originate from user-selected workspaces.
  // A plain img keeps arbitrary signed hosts usable without weakening Next's global image policy.
  // eslint-disable-next-line @next/next/no-img-element
  if (/^https?:\/\//u.test(value)) return <img className="database-icon" src={value} alt="" />;
  return <span className="database-icon">{value}</span>;
}

export function NotionSetupDialog({
  notionStatus, status, coverage, databases, databasesLoading, savingSelection,
  selectionSavedAt, indexAvailable, error, onClose, onLoadDatabases,
  onSaveDatabases, onSync, onCancelSync, onInstallEmbeddingModel, onResetIndex,
}: Props) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  // The callback is async: returning it would hand React a Promise as the cleanup
  // function, and calling it on unmount tears down the whole root.
  useEffect(() => { onLoadDatabases(); }, [onLoadDatabases]);

  const stored = useMemo(() => databases.filter((database) => database.selected).map((database) => database.id), [databases]);
  const selection = draft ?? stored;
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("de-DE");
    if (!term) return databases;
    return databases.filter((database) => [database.title, database.originalTitle, database.parentTitle]
      .filter(Boolean).join(" ").toLocaleLowerCase("de-DE").includes(term));
  }, [databases, search]);
  const toggle = (id: string) => setDraft(selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id]);
  const sync = status?.sync;
  const models = status?.models;

  return (
    <div className="setup-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="setup-panel" role="dialog" aria-modal="true" aria-labelledby="notion-setup-title">
        <header className="setup-head">
          <div><span className="eyebrow">LOCAL KNOWLEDGE INDEX</span><h2 id="notion-setup-title">Notion-Datenbanken auswählen</h2></div>
          <button className="setup-close" onClick={onClose} aria-label="Dialog schließen">×</button>
        </header>

        <div className={`connection-card ${notionStatus.connected ? "connected" : ""}`}>
          <i /><div><strong>{notionStatus.connected ? "Verbindung aktiv" : "Noch nicht verbunden"}</strong>
            <span>{notionStatus.connected ? `${notionStatus.workspaceName || "Notion Workspace"} · nur lesend · lokal auf diesem Mac` : "Dein Token bleibt ausschließlich lokal auf diesem MacBook."}</span></div>
        </div>

        {!indexAvailable ? <p className="setup-error">Der lokale Index ist momentan nicht erreichbar. Starte JARVIS erneut und versuche es noch einmal.</p> : null}

        {notionStatus.connected ? <>
          <div className="connected-summary">
            <div><b>{NUMBER.format(coverage.selectedDatabases ?? coverage.selectedRoots)}</b><span>Datenbanken</span></div>
            <div><b>{NUMBER.format(coverage.indexedSources)}</b><span>Seiten</span></div>
            <div><b>{NUMBER.format(coverage.concepts)}</b><span>Konzepte</span></div>
            <div><b>{NUMBER.format(coverage.relations)}</b><span>Beziehungen</span></div>
          </div>

          <section className="area-picker" aria-label="Notion-Datenbanken">
            <div className="area-picker-head">
              <span className="eyebrow">{selection.length} VON {databases.length} DATENBANKEN</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Datenbank suchen" aria-label="Datenbank suchen" />
            </div>
            <div className="area-quick-actions">
              <button type="button" onClick={() => setDraft(databases.map((database) => database.id))}>ALLE AUSWÄHLEN</button>
              <button type="button" onClick={() => setDraft([])}>AUSWAHL LEEREN</button>
            </div>
            <div className="area-list database-list">
              {databasesLoading && !databases.length ? <p>Freigegebene Datenbanken werden gesucht …</p> : null}
              {!databasesLoading && !databases.length ? <p>Keine freigegebenen Notion-Datenbanken gefunden. Teile mindestens eine Datenbank mit deiner Integration.</p> : null}
              {visible.map((database) => <article key={database.id} className={`area-card database-card ${selection.includes(database.id) ? "is-selected" : ""}`}>
                <label>
                  <input type="checkbox" checked={selection.includes(database.id)} onChange={() => toggle(database.id)} />
                  <DatabaseIcon value={database.icon} />
                  <span><strong>{database.title}</strong><small>{database.parentTitle ? `in ${database.parentTitle}` : "Notion-Datenbank"} · {NUMBER.format(database.contentCount)} Seiten</small>
                    {database.originalTitle && database.originalTitle !== database.title ? <p>Notion-Titel: {database.originalTitle}</p> : null}</span>
                </label>
              </article>)}
            </div>
            <div className="area-save">
              <button className="secondary-action" onClick={() => onSaveDatabases(selection)} disabled={savingSelection || databasesLoading}>
                {savingSelection ? "AUSWAHL WIRD GESPEICHERT …" : "AUSWAHL SPEICHERN & INDEX STARTEN"}
              </button>
              {selectionSavedAt && !savingSelection ? <span className="area-save-state" role="status">Gespeichert · der bestehende Graph bleibt während der Aktualisierung sichtbar</span> : null}
            </div>
          </section>

          <section className="model-card" aria-label="Lokale Modelle">
            <span className="eyebrow">LOKALE KI · NUR BEI FRAGEN</span>
            <p><b>{models?.chatModel ?? "qwen3.5:4b"}</b> · {models?.chatModelAvailable ? "bereit" : "fehlt"}</p>
            <p><b>{models?.embeddingModel ?? "embeddinggemma"}</b> · {models?.embeddingModelAvailable ? "semantische Suche bereit" : models?.pulling ? models.pullProgress ?? "wird geladen" : "optional, nicht installiert"}</p>
            {!models?.embeddingModelAvailable ? <button className="secondary-action" onClick={onInstallEmbeddingModel} disabled={models?.pulling}>{models?.pulling ? "MODELL WIRD GELADEN …" : "EMBEDDING-MODELL INSTALLIEREN"}</button> : null}
          </section>
        </> : <ol className="setup-steps">
          <li><span className="setup-number">01</span><div><strong>Interne Integration anlegen</strong><p>Erstelle in Notion eine Integration namens JARVIS mit Leserechten.</p></div></li>
          <li><span className="setup-number">02</span><div><strong>Datenbanken freigeben</strong><p>Teile nur die Datenbanken, die JARVIS lokal indexieren darf.</p></div></li>
          <li><span className="setup-number">03</span><div><strong>Token lokal eintragen</strong><pre>NOTION_ACCESS_TOKEN=secret_dein_token</pre></div></li>
        </ol>}

        {sync && sync.phase !== "idle" ? <div className="sync-progress" aria-live="polite">
          <span className="eyebrow">{PHASE_LABEL[sync.phase] ?? sync.phase.toLocaleUpperCase("de-DE")}</span>
          <strong>{sync.currentDatabaseTitle ?? "Lokaler Wissensindex"}</strong>
          <p>{sync.totalDatabases ? `Datenbank ${Math.min(sync.processedDatabases + 1, sync.totalDatabases)} von ${sync.totalDatabases}` : ""}
            {sync.totalSources ? ` · ${sync.processedSources} von ${sync.totalSources} Seiten` : ""}
            {sync.failedSources ? ` · ${sync.failedSources} übersprungen` : ""}</p>
          {status?.running ? <button type="button" className="secondary-action" onClick={onCancelSync}>SYNC ABBRECHEN</button> : null}
        </div> : null}

        {(error || notionStatus.error || sync?.error) ? <p className="setup-error">{error || notionStatus.error || sync?.error}</p> : null}
        <div className="setup-actions">
          {!notionStatus.connected ? <button className="secondary-action" onClick={() => void openExternalUrl("https://www.notion.so/my-integrations")}>NOTION INTEGRATION ↗</button> : null}
          {notionStatus.connected ? <button className="secondary-action" onClick={() => onSync("incremental")} disabled={status?.running}>JETZT AKTUALISIEREN</button> : null}
          <button className="danger-action" onClick={() => { if (!resetArmed) return setResetArmed(true); setResetArmed(false); onResetIndex(); }}>{resetArmed ? "WIRKLICH LÖSCHEN?" : "LOKALEN INDEX NEU AUFBAUEN"}</button>
        </div>
      </section>
    </div>
  );
}
