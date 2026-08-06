/**
 * Google account access for the voice assistant. The login is Authorization Code with PKCE on
 * a loopback port, and the granted scopes are limited to calendar events and reading mail.
 * There is no scope that could send or change a single message.
 */
import type { Server } from "node:http";
import {
  GOOGLE_FORBIDDEN_SCOPE_PATTERN,
  GOOGLE_SCOPES,
  googleClientId,
  googleClientSecret,
  googleRedirectPort,
  googleRedirectUri,
} from "./config";
import { LocalActionError, openExternalUrl } from "./macos";
import { callbackPage, createPkcePair, safeEquals, startCallbackServer } from "./oauth-loopback";
import { clearSecret, readSecret, writeSecret } from "./store";

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  accountEmail?: string;
};

type PendingAuthorization = {
  verifier: string;
  state: string;
  server: Server;
  expiresAt: number;
};

const TOKEN_FILE = "google-auth.json";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const AUTHORIZATION_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

let pending: PendingAuthorization | null = null;
let lastAuthorizationError: string | null = null;

function tokens() {
  return readSecret<StoredTokens>(TOKEN_FILE);
}

/**
 * The scope list is code, not configuration, but a wrong edit here would ask the user to grant
 * far more than the assistant needs. The login refuses to start instead.
 */
function assertAllowedScopes() {
  const offending = GOOGLE_SCOPES.find((scope) => GOOGLE_FORBIDDEN_SCOPE_PATTERN.test(scope));
  if (offending) {
    throw new LocalActionError(`Die Berechtigung ${offending} darf JARVIS nicht anfragen.`, 500);
  }
}

async function timedFetch(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch {
    throw new LocalActionError("Google ist gerade nicht erreichbar.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function closePendingAuthorization() {
  if (!pending) return;
  pending.server.close();
  pending = null;
}

function tokenRequestBody(fields: Record<string, string>) {
  const secret = googleClientSecret();
  return new URLSearchParams(secret ? { ...fields, client_secret: secret } : fields);
}

async function exchangeCode(code: string, verifier: string) {
  const response = await timedFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: googleRedirectUri(),
      client_id: googleClientId(),
      code_verifier: verifier,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const description = typeof payload.error_description === "string" ? payload.error_description : "";
    throw new LocalActionError(description || "Google hat die Anmeldung abgelehnt.", 502);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : "",
    expiresAt: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in : 3600) * 1000,
    scope: typeof payload.scope === "string" ? payload.scope : "",
  } satisfies StoredTokens;
}

/** The mail profile doubles as the account name, so no extra identity scope is needed. */
async function loadAccountEmail(accessToken: string) {
  const response = await timedFetch(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return undefined;
  const profile = await response.json().catch(() => ({})) as Record<string, unknown>;
  return typeof profile.emailAddress === "string" ? profile.emailAddress : undefined;
}

async function handleCallback(url: URL) {
  if (!pending) return callbackPage("Anmeldung abgelaufen", "Starte die Verbindung in JARVIS noch einmal.");

  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";

  if (error) {
    lastAuthorizationError = error === "access_denied"
      ? "Der Zugriff auf das Google-Konto wurde abgelehnt."
      : `Google meldet: ${error}`;
    return callbackPage("Nicht verbunden", lastAuthorizationError);
  }
  if (!code || !safeEquals(state, pending.state)) {
    lastAuthorizationError = "Die Antwort von Google passt nicht zur gestarteten Anmeldung.";
    return callbackPage("Nicht verbunden", lastAuthorizationError);
  }

  try {
    const exchanged = await exchangeCode(code, pending.verifier);
    const accountEmail = await loadAccountEmail(exchanged.accessToken);
    writeSecret(TOKEN_FILE, { ...exchanged, accountEmail });
    lastAuthorizationError = null;
    return callbackPage("Google verbunden", "Du kannst dieses Fenster schließen und mit JARVIS weitersprechen.");
  } catch (exchangeError) {
    lastAuthorizationError = exchangeError instanceof Error ? exchangeError.message : "Die Anmeldung ist fehlgeschlagen.";
    return callbackPage("Nicht verbunden", lastAuthorizationError);
  }
}

/** Starts the login: opens the Google consent screen and waits on the loopback port. */
export async function beginAuthorization() {
  if (!googleClientId()) {
    throw new LocalActionError(
      "Es ist keine Google-Client-ID hinterlegt. Trage GOOGLE_CLIENT_ID in .env.local ein.",
      503,
    );
  }
  assertAllowedScopes();
  closePendingAuthorization();
  lastAuthorizationError = null;

  const { verifier, challenge, state } = createPkcePair();
  const port = googleRedirectPort();
  const server = await startCallbackServer(port, async (url) => {
    const page = await handleCallback(url);
    setTimeout(closePendingAuthorization, 500).unref();
    return page;
  });

  pending = { verifier, state, server, expiresAt: Date.now() + AUTHORIZATION_TTL_MS };
  setTimeout(() => {
    if (pending && pending.expiresAt <= Date.now()) closePendingAuthorization();
  }, AUTHORIZATION_TTL_MS).unref();

  const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: googleClientId(),
    response_type: "code",
    redirect_uri: googleRedirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: GOOGLE_SCOPES.join(" "),
    // Offline access keeps the assistant usable without a login every hour.
    access_type: "offline",
    prompt: "consent",
  })}`;

  await openExternalUrl(authorizeUrl);
  return { authorizing: true, redirectUri: googleRedirectUri() };
}

export async function disconnect() {
  closePendingAuthorization();
  const stored = tokens();
  clearSecret(TOKEN_FILE);
  lastAuthorizationError = null;
  // Revoking is best effort; the local tokens are gone either way.
  if (stored?.refreshToken || stored?.accessToken) {
    await timedFetch(`${REVOKE_URL}?${new URLSearchParams({ token: stored.refreshToken || stored.accessToken })}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }).catch(() => undefined);
  }
  return { connected: false };
}

export function connectionStatus() {
  const stored = tokens();
  return {
    configured: Boolean(googleClientId()),
    connected: Boolean(stored?.refreshToken || stored?.accessToken),
    authorizing: Boolean(pending),
    accountEmail: stored?.accountEmail,
    error: lastAuthorizationError ?? undefined,
  };
}

async function refreshTokens(stored: StoredTokens) {
  if (!stored.refreshToken) {
    throw new LocalActionError("Die Google-Anmeldung ist abgelaufen. Bitte verbinde Google neu.", 401);
  }
  const response = await timedFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: googleClientId(),
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new LocalActionError("Die Google-Anmeldung ist abgelaufen. Bitte verbinde Google neu.", 401);
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
  if (!stored) throw new LocalActionError("Das Google-Konto ist noch nicht verbunden.", 401);
  if (!forceRefresh && stored.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return stored.accessToken;
  return (await refreshTokens(stored)).accessToken;
}

/** One authorized call against a Google API, with a single retry after a token refresh. */
export async function googleRequest(
  url: string,
  init: RequestInit = {},
  retryOnUnauthorized = true,
): Promise<unknown> {
  const token = await accessToken();
  const response = await timedFetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  if (response.status === 401 && retryOnUnauthorized) {
    await accessToken(true);
    return googleRequest(url, init, false);
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string; status?: string } };

  if (response.ok) return payload;
  if (response.status === 401) {
    throw new LocalActionError("Die Google-Anmeldung ist abgelaufen. Bitte verbinde Google neu.", 401);
  }
  if (response.status === 403) {
    throw new LocalActionError(
      "Die erteilte Google-Freigabe reicht dafür nicht. Verbinde das Konto in JARVIS noch einmal.",
      403,
    );
  }
  if (response.status === 429) {
    throw new LocalActionError("Google bremst die Anfragen gerade aus. Versuch es gleich noch einmal.", 429);
  }
  throw new LocalActionError(payload.error?.message || "Google hat die Anfrage abgelehnt.", 502);
}
