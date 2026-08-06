/** Client bridge to the local action layer that runs Spotify and macOS commands. */
import type { AssistantTool } from "../tools";
import type { GoogleConnectionStatus, LocalActionStatus, SpotifyConnectionStatus } from "../types";

type LocalActionResponse = { ok?: boolean; summary?: string; error?: string; code?: string };
type ToolArguments = Record<string, unknown>;

export const LOCAL_ACTION_BASE = "/api/local";

async function postLocal(path: string, body: ToolArguments = {}, signal?: AbortSignal) {
  const response = await fetch(`${LOCAL_ACTION_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as LocalActionResponse;
  if (!response.ok) throw new Error(payload.error || "Die Aktion auf diesem Mac ist fehlgeschlagen.");
  return payload;
}

/**
 * Executes a tool that needs this Mac. Irreversible tools only ever arrive here with an
 * explicit confirmation, and the action layer rejects them without it as well.
 */
export async function runLocalTool(
  tool: AssistantTool,
  args: ToolArguments,
  options: { confirmed?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  if (!tool.path) throw new Error(`Das Werkzeug ${tool.name} hat keine lokale Aktion.`);
  const payload = await postLocal(
    tool.path,
    options.confirmed ? { ...args, confirmed: true } : args,
    options.signal,
  );
  return payload.summary || "Erledigt.";
}

export async function loadLocalStatus(signal?: AbortSignal): Promise<LocalActionStatus | null> {
  try {
    const response = await fetch(`${LOCAL_ACTION_BASE}/status`, { cache: "no-store", signal });
    if (!response.ok) return null;
    return await response.json() as LocalActionStatus;
  } catch {
    return null;
  }
}

export async function connectSpotify(signal?: AbortSignal) {
  return postLocal("/spotify/connect", {}, signal);
}

export async function disconnectSpotify(signal?: AbortSignal) {
  return postLocal("/spotify/disconnect", {}, signal);
}

export async function loadSpotifyStatus(signal?: AbortSignal): Promise<SpotifyConnectionStatus | null> {
  try {
    const response = await fetch(`${LOCAL_ACTION_BASE}/spotify/status`, { cache: "no-store", signal });
    if (!response.ok) return null;
    return await response.json() as SpotifyConnectionStatus;
  } catch {
    return null;
  }
}

export async function connectGoogle(signal?: AbortSignal) {
  return postLocal("/google/connect", {}, signal);
}

export async function disconnectGoogle(signal?: AbortSignal) {
  return postLocal("/google/disconnect", {}, signal);
}

export async function loadGoogleStatus(signal?: AbortSignal): Promise<GoogleConnectionStatus | null> {
  try {
    const response = await fetch(`${LOCAL_ACTION_BASE}/google/status`, { cache: "no-store", signal });
    if (!response.ok) return null;
    return await response.json() as GoogleConnectionStatus;
  } catch {
    return null;
  }
}
