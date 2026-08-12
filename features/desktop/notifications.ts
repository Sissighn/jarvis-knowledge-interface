const BRIEFING_NOTIFICATION_KEY = "jarvis-desktop-briefing-notification-v1";

function isTauriDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Sends one native notification, or stays silent when there is no desktop shell to send it. */
async function notify(title: string, body: string) {
  if (!isTauriDesktop()) return false;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = await requestPermission() === "granted";
    if (!granted) return false;

    sendNotification({ title, body, sound: "Ping" });
    return true;
  } catch {
    // Browser usage and denied native permissions remain silent by design.
    return false;
  }
}

/**
 * Announces a deadline that is running out. The caller decides when a to-do is due; this only
 * reports it, and reports nothing at all outside the packaged app.
 */
export async function notifyTodoDue(title: string, when: string, overdue: boolean) {
  return notify(
    overdue ? "JARVIS · Überfällig" : "JARVIS · Aufgabe fällig",
    when ? `${title} — ${when}` : title,
  );
}

export async function notifyBriefingReady(date: string, itemCount: number) {
  if (!isTauriDesktop() || itemCount < 1) return;
  if (window.localStorage.getItem(BRIEFING_NOTIFICATION_KEY) === date) return;

  const sent = await notify(
    "JARVIS · Morning Tech Brief",
    `${itemCount} relevante ${itemCount === 1 ? "Meldung ist" : "Meldungen sind"} bereit.`,
  );
  if (sent) window.localStorage.setItem(BRIEFING_NOTIFICATION_KEY, date);
}
