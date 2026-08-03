const BRIEFING_NOTIFICATION_KEY = "jarvis-desktop-briefing-notification-v1";

function isTauriDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function notifyBriefingReady(date: string, itemCount: number) {
  if (!isTauriDesktop() || itemCount < 1) return;
  if (window.localStorage.getItem(BRIEFING_NOTIFICATION_KEY) === date) return;

  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = await requestPermission() === "granted";
    if (!granted) return;

    sendNotification({
      title: "JARVIS · Morning Tech Brief",
      body: `${itemCount} relevante ${itemCount === 1 ? "Meldung ist" : "Meldungen sind"} bereit.`,
      sound: "Ping",
    });
    window.localStorage.setItem(BRIEFING_NOTIFICATION_KEY, date);
  } catch {
    // Browser usage and denied native permissions remain silent by design.
  }
}
