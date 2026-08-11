/**
 * Opening a web address that belongs outside this app — an article in the briefing, a Notion
 * page, a source link.
 *
 * In the packaged app this cannot be done with `window.open`: the webview of the desktop shell
 * has no handler for a second window, so WebKit drops the request without a word and the click
 * looks broken. There the address goes to the local action layer, which hands it to the browser
 * this Mac uses by default. In an ordinary browser tab the normal new tab is exactly right.
 */

const OPEN_LINK_ACTION = "/api/local/browser/open-link";

function isTauriDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Empty when the address was opened, otherwise the German reason it was not. An entry without a
 * link is a normal case here, not a caller mistake, so a missing address is accepted and named.
 */
export async function openExternalUrl(url: string | undefined): Promise<string> {
  const target = typeof url === "string" ? url.trim() : "";
  if (!target) return "Zu diesem Eintrag gibt es keine Adresse.";

  if (!isTauriDesktop()) {
    window.open(target, "_blank", "noopener,noreferrer");
    return "";
  }

  try {
    const response = await fetch(OPEN_LINK_ACTION, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
    });
    if (response.ok) return "";
    const payload = await response.json().catch(() => ({})) as { error?: string };
    return payload.error || "Der Link ließ sich nicht öffnen.";
  } catch {
    return "Der Link ließ sich nicht öffnen.";
  }
}
