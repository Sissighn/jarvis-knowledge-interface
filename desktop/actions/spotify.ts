/**
 * Spotify Web API access for the voice assistant. The login uses Authorization Code with
 * PKCE against a short-lived loopback server, so no client secret is ever stored.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { SPOTIFY_SCOPES, spotifyClientId, spotifyRedirectPort, spotifyRedirectUri } from "./config";
import { LocalActionError, openApp, openExternalUrl } from "./macos";
import { clearSecret, readSecret, writeSecret } from "./store";

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  accountName?: string;
  product?: string;
};

type PendingAuthorization = {
  verifier: string;
  state: string;
  server: Server;
  expiresAt: number;
};

type SpotifyDevice = { id?: string | null; name?: string; is_active?: boolean };
type SpotifyArtist = { name?: string };
type SpotifyItem = { uri?: string; name?: string; artists?: SpotifyArtist[]; album?: { name?: string } };

const TOKEN_FILE = "spotify-auth.json";
const ACCOUNTS_BASE_URL = "https://accounts.spotify.com";
const API_BASE_URL = "https://api.spotify.com/v1";
const AUTHORIZATION_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEVICE_WAIT_ATTEMPTS = 8;
const DEVICE_WAIT_INTERVAL_MS = 900;

let pending: PendingAuthorization | null = null;
let lastAuthorizationError: string | null = null;

function tokens() {
  return readSecret<StoredTokens>(TOKEN_FILE);
}

function base64Url(value: Buffer) {
  return value.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function safeEquals(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function timedFetch(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch {
    throw new LocalActionError("Spotify ist gerade nicht erreichbar.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function closePendingAuthorization() {
  if (!pending) return;
  pending.server.close();
  pending = null;
}

function callbackPage(title: string, message: string) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title>`
    + "<style>body{background:#090508;color:#f6e9f1;font-family:-apple-system,system-ui,sans-serif;"
    + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}"
    + "main{text-align:center;max-width:32rem;padding:2rem}h1{font-size:1.25rem;letter-spacing:.08em;text-transform:uppercase}"
    + "p{opacity:.75;line-height:1.6}</style></head>"
    + `<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

async function exchangeCode(code: string, verifier: string) {
  const response = await timedFetch(`${ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: spotifyRedirectUri(),
      client_id: spotifyClientId(),
      code_verifier: verifier,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const description = typeof payload.error_description === "string" ? payload.error_description : "";
    throw new LocalActionError(description || "Spotify hat die Anmeldung abgelehnt.", 502);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : "",
    expiresAt: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in : 3600) * 1000,
    scope: typeof payload.scope === "string" ? payload.scope : "",
  } satisfies StoredTokens;
}

async function loadProfile(accessToken: string) {
  const response = await timedFetch(`${API_BASE_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return {};
  const profile = await response.json().catch(() => ({})) as Record<string, unknown>;
  return {
    accountName: typeof profile.display_name === "string" ? profile.display_name : undefined,
    product: typeof profile.product === "string" ? profile.product : undefined,
  };
}

async function handleCallback(url: URL) {
  if (!pending) return callbackPage("Anmeldung abgelaufen", "Starte die Verbindung in JARVIS noch einmal.");

  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";

  if (error) {
    lastAuthorizationError = error === "access_denied"
      ? "Der Zugriff auf Spotify wurde abgelehnt."
      : `Spotify meldet: ${error}`;
    return callbackPage("Nicht verbunden", lastAuthorizationError);
  }
  if (!code || !safeEquals(state, pending.state)) {
    lastAuthorizationError = "Die Antwort von Spotify passt nicht zur gestarteten Anmeldung.";
    return callbackPage("Nicht verbunden", lastAuthorizationError);
  }

  try {
    const exchanged = await exchangeCode(code, pending.verifier);
    const profile = await loadProfile(exchanged.accessToken);
    writeSecret(TOKEN_FILE, { ...exchanged, ...profile });
    lastAuthorizationError = null;
    return callbackPage("Spotify verbunden", "Du kannst dieses Fenster schließen und mit JARVIS weitersprechen.");
  } catch (exchangeError) {
    lastAuthorizationError = exchangeError instanceof Error ? exchangeError.message : "Die Anmeldung ist fehlgeschlagen.";
    return callbackPage("Nicht verbunden", lastAuthorizationError);
  }
}

/** Starts the login: opens Spotify in the default browser and waits on the loopback port. */
export async function beginAuthorization() {
  if (!spotifyClientId()) {
    throw new LocalActionError("Es ist keine Spotify-Client-ID hinterlegt. Trage SPOTIFY_CLIENT_ID in .env.local ein.", 503);
  }
  closePendingAuthorization();
  lastAuthorizationError = null;

  const verifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(16));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const port = spotifyRedirectPort();

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname !== "/callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }
    void handleCallback(requestUrl).then((page) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(page);
      setTimeout(closePendingAuthorization, 500).unref();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  }).catch(() => {
    throw new LocalActionError(`Der Anmeldeport ${port} ist belegt. Schließe das andere Programm und versuche es erneut.`, 503);
  });

  pending = { verifier, state, server, expiresAt: Date.now() + AUTHORIZATION_TTL_MS };
  setTimeout(() => {
    if (pending && pending.expiresAt <= Date.now()) closePendingAuthorization();
  }, AUTHORIZATION_TTL_MS).unref();

  const authorizeUrl = `${ACCOUNTS_BASE_URL}/authorize?${new URLSearchParams({
    client_id: spotifyClientId(),
    response_type: "code",
    redirect_uri: spotifyRedirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SPOTIFY_SCOPES.join(" "),
  })}`;

  await openExternalUrl(authorizeUrl);
  return { authorizing: true, redirectUri: spotifyRedirectUri() };
}

export function disconnect() {
  closePendingAuthorization();
  clearSecret(TOKEN_FILE);
  lastAuthorizationError = null;
  return { connected: false };
}

export function connectionStatus() {
  const stored = tokens();
  return {
    configured: Boolean(spotifyClientId()),
    connected: Boolean(stored?.refreshToken || stored?.accessToken),
    authorizing: Boolean(pending),
    accountName: stored?.accountName,
    premium: stored?.product ? stored.product === "premium" : undefined,
    error: lastAuthorizationError ?? undefined,
  };
}

async function refreshTokens(stored: StoredTokens) {
  if (!stored.refreshToken) {
    throw new LocalActionError("Die Spotify-Anmeldung ist abgelaufen. Bitte verbinde Spotify neu.", 401);
  }
  const response = await timedFetch(`${ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: spotifyClientId(),
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new LocalActionError("Die Spotify-Anmeldung ist abgelaufen. Bitte verbinde Spotify neu.", 401);
  }
  const refreshed: StoredTokens = {
    ...stored,
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : stored.refreshToken,
    expiresAt: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in : 3600) * 1000,
  };
  writeSecret(TOKEN_FILE, refreshed);
  return refreshed;
}

async function accessToken(forceRefresh = false) {
  const stored = tokens();
  if (!stored) throw new LocalActionError("Spotify ist noch nicht verbunden.", 401);
  if (!forceRefresh && stored.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return stored.accessToken;
  return (await refreshTokens(stored)).accessToken;
}

async function spotifyRequest(path: string, init: RequestInit = {}, retryOnUnauthorized = true): Promise<unknown> {
  const token = await accessToken();
  const response = await timedFetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  if (response.status === 401 && retryOnUnauthorized) {
    await accessToken(true);
    return spotifyRequest(path, init, false);
  }
  if (response.status === 204 || response.status === 202) return null;
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string; reason?: string } };

  if (response.ok) return payload;
  const reason = payload.error?.reason ?? "";
  if (response.status === 403 || reason === "PREMIUM_REQUIRED") {
    throw new LocalActionError("Dafür braucht Spotify ein Premium-Konto.", 403);
  }
  if (response.status === 404 || reason === "NO_ACTIVE_DEVICE") {
    throw new LocalActionError("Spotify hat gerade kein aktives Wiedergabegerät.", 404);
  }
  if (response.status === 429) {
    throw new LocalActionError("Spotify bremst die Anfragen gerade aus. Versuch es gleich noch einmal.", 429);
  }
  throw new LocalActionError(payload.error?.message || "Spotify hat die Anfrage abgelehnt.", 502);
}

async function listDevices() {
  const payload = await spotifyRequest("/me/player/devices") as { devices?: SpotifyDevice[] } | null;
  return payload?.devices ?? [];
}

/** Makes sure something can actually play; starts the Spotify app when no device is awake. */
async function ensureActiveDevice() {
  const devices = await listDevices();
  const active = devices.find((device) => device.is_active && device.id);
  if (active?.id) return active;

  const available = devices.find((device) => device.id);
  if (available?.id) {
    await spotifyRequest("/me/player", {
      method: "PUT",
      body: JSON.stringify({ device_ids: [available.id], play: false }),
    });
    return available;
  }

  await openApp("Spotify").catch(() => undefined);
  for (let attempt = 0; attempt < DEVICE_WAIT_ATTEMPTS; attempt += 1) {
    await delay(DEVICE_WAIT_INTERVAL_MS);
    const started = (await listDevices()).find((device) => device.id);
    if (started?.id) {
      await spotifyRequest("/me/player", {
        method: "PUT",
        body: JSON.stringify({ device_ids: [started.id], play: false }),
      });
      return started;
    }
  }
  throw new LocalActionError("Spotify hat kein Wiedergabegerät gefunden. Öffne Spotify und starte einmal kurz die Wiedergabe.", 404);
}

function describeItem(item: SpotifyItem | null | undefined) {
  if (!item?.name) return "";
  const artists = (item.artists ?? []).map((artist) => artist.name).filter(Boolean).join(", ");
  const album = item.album?.name;
  return [item.name, artists && `von ${artists}`, album && `aus dem Album ${album}`].filter(Boolean).join(" ");
}

const SEARCH_KEYS = {
  track: "tracks",
  artist: "artists",
  album: "albums",
  playlist: "playlists",
} as const;

export type SpotifySearchType = keyof typeof SEARCH_KEYS;

export async function play(query: string, type: SpotifySearchType) {
  if (!query) throw new LocalActionError("Ich habe nicht verstanden, was ich abspielen soll.", 400);
  const search = await spotifyRequest(
    `/search?${new URLSearchParams({ q: query, type, limit: "1", market: "from_token" })}`,
  ) as Record<string, { items?: Array<SpotifyItem | null> }> | null;

  const item = search?.[SEARCH_KEYS[type]]?.items?.find((entry) => entry?.uri);
  if (!item?.uri) throw new LocalActionError(`Ich habe auf Spotify nichts zu ${query} gefunden.`, 404);

  const device = await ensureActiveDevice();
  const body = type === "track" ? { uris: [item.uri] } : { context_uri: item.uri };
  await spotifyRequest(`/me/player/play?${new URLSearchParams({ device_id: device.id ?? "" })}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return { started: true, description: describeItem(item) || item.name || query, device: device.name ?? "" };
}

export async function pause() {
  await spotifyRequest("/me/player/pause", { method: "PUT" });
  return { paused: true };
}

export async function resume() {
  const device = await ensureActiveDevice();
  await spotifyRequest(`/me/player/play?${new URLSearchParams({ device_id: device.id ?? "" })}`, { method: "PUT" });
  return { resumed: true };
}

export async function skipNext() {
  await spotifyRequest("/me/player/next", { method: "POST" });
  return { skipped: "next" as const };
}

export async function skipPrevious() {
  await spotifyRequest("/me/player/previous", { method: "POST" });
  return { skipped: "previous" as const };
}

export async function setVolume(percent: number) {
  const target = Math.max(0, Math.min(100, Math.round(percent)));
  await spotifyRequest(`/me/player/volume?${new URLSearchParams({ volume_percent: String(target) })}`, {
    method: "PUT",
  });
  return { percent: target };
}

export async function currentTrack() {
  const payload = await spotifyRequest("/me/player/currently-playing") as
    { item?: SpotifyItem | null; is_playing?: boolean } | null;
  if (!payload?.item) return { playing: false, description: "" };
  return {
    playing: payload.is_playing !== false,
    description: describeItem(payload.item),
  };
}
