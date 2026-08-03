import type { GraphPayload, NotionStatus } from "../types";

type NotionSetupDialogProps = {
  open: boolean;
  status: NotionStatus;
  graphMeta: Omit<GraphPayload, "nodes" | "edges"> | null;
  syncing: boolean;
  error: string | null;
  onClose(): void;
  onSync(): void;
};

export function NotionSetupDialog({ open, status, graphMeta, syncing, error, onClose, onSync }: NotionSetupDialogProps) {
  if (!open) return null;

  return (
    <div className="setup-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="setup-panel" role="dialog" aria-modal="true" aria-labelledby="notion-setup-title">
        <header className="setup-head">
          <div><span className="eyebrow">LOCAL DATA CONNECTION</span><h2 id="notion-setup-title">Notion verbinden</h2></div>
          <button className="setup-close" onClick={onClose} aria-label="Dialog schließen">×</button>
        </header>

        <div className={`connection-card ${status.connected ? "connected" : ""}`}>
          <i />
          <div>
            <strong>{status.connected ? "Verbindung aktiv" : "Noch nicht verbunden"}</strong>
            <span>{status.connected
              ? `${status.workspaceName || "Notion Workspace"} · nur lesend`
              : "Dein Token bleibt ausschließlich lokal auf diesem MacBook."}</span>
          </div>
        </div>

        {status.connected ? (
          <div className="connected-summary">
            <div><b>{graphMeta?.pageCount ?? 0}</b><span>Seiten</span></div>
            <div><b>{graphMeta?.dataSourceCount ?? 0}</b><span>Datenquellen</span></div>
            <div><b>{graphMeta?.similarityEdgeCount ?? 0}</b><span>Ähnlichkeiten</span></div>
          </div>
        ) : (
          <ol className="setup-steps">
            <li><span className="setup-number">01</span><div><strong>Interne Integration anlegen</strong><p>Erstelle in Notion eine Integration namens JARVIS und erteile nur Leserechte.</p></div></li>
            <li><span className="setup-number">02</span><div><strong>Ausgewählte Inhalte freigeben</strong><p>Verbinde nur die Notion-Seiten und Datenbanken, die JARVIS sehen darf.</p></div></li>
            <li><span className="setup-number">03</span><div><strong>Token lokal eintragen</strong><p>Lege im Projekt eine Datei <code>.env.local</code> an:</p><pre>NOTION_ACCESS_TOKEN=secret_dein_token</pre></div></li>
          </ol>
        )}

        {(error || status.error) && <p className="setup-error">{error || status.error}</p>}
        <div className="setup-actions">
          {!status.connected && (
            <button className="secondary-action" onClick={() => window.open("https://www.notion.so/my-integrations", "_blank", "noopener,noreferrer")}>NOTION INTEGRATION ↗</button>
          )}
          <button className="primary-action" disabled={syncing} onClick={onSync}>
            {syncing ? "WIRD SYNCHRONISIERT …" : status.connected ? "JETZT SYNCHRONISIEREN" : "STATUS PRÜFEN"}
          </button>
        </div>
      </section>
    </div>
  );
}
