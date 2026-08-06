/** Local-only configuration for everything the assistant may do on this Mac. */
import { homedir } from "node:os";

export const LOCAL_ACTION_PREFIX = "/api/local";
export const DEFAULT_SPOTIFY_REDIRECT_PORT = 4319;
export const DEFAULT_GOOGLE_REDIRECT_PORT = 4320;
export const DEFAULT_TIME_ZONE = "Europe/Berlin";

export type AllowedApp = { name: string; aliases: string[] };

/**
 * Only these programs may be launched by voice. Everything else is rejected, even when
 * the model asks for it. Extend the list through JARVIS_ALLOWED_APPS.
 */
const DEFAULT_ALLOWED_APPS: AllowedApp[] = [
  { name: "Spotify", aliases: ["spotify"] },
  { name: "Safari", aliases: ["safari", "browser"] },
  { name: "Google Chrome", aliases: ["chrome", "google chrome"] },
  { name: "Notion", aliases: ["notion"] },
  { name: "Visual Studio Code", aliases: ["vs code", "vscode", "code", "visual studio code"] },
  { name: "Mail", aliases: ["mail", "email", "e mail", "apple mail"] },
  { name: "Calendar", aliases: ["kalender", "calendar"] },
  { name: "Notes", aliases: ["notizen", "notes"] },
  { name: "Reminders", aliases: ["erinnerungen", "reminders"] },
  { name: "Music", aliases: ["musik", "music", "apple music"] },
  { name: "Finder", aliases: ["finder", "dateien"] },
  { name: "Preview", aliases: ["vorschau", "preview"] },
  { name: "Photos", aliases: ["fotos", "photos"] },
  { name: "System Settings", aliases: ["systemeinstellungen", "einstellungen", "system settings"] },
  { name: "Calculator", aliases: ["rechner", "taschenrechner", "calculator"] },
];

export function normalizeAppName(value: string) {
  return value
    .toLowerCase()
    .replace(/\.app$/u, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function allowedApps(): AllowedApp[] {
  const configured = (process.env.JARVIS_ALLOWED_APPS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((name) => ({ name, aliases: [normalizeAppName(name)] }));
  const known = new Set(DEFAULT_ALLOWED_APPS.map((app) => normalizeAppName(app.name)));
  return [...DEFAULT_ALLOWED_APPS, ...configured.filter((app) => !known.has(normalizeAppName(app.name)))];
}

/** Resolves a spoken program name to an allowlisted application, or null when it is not allowed. */
export function resolveAllowedApp(spoken: string) {
  const wanted = normalizeAppName(spoken);
  if (!wanted) return null;
  const apps = allowedApps();
  return apps.find((app) => normalizeAppName(app.name) === wanted)
    ?? apps.find((app) => app.aliases.includes(wanted))
    ?? apps.find((app) => app.aliases.some((alias) => alias.startsWith(wanted) || wanted.startsWith(alias)))
    ?? null;
}

/** Files and folders may only be opened inside the personal home directory. */
export function homeDirectory() {
  return homedir();
}

export function spotifyClientId() {
  return process.env.SPOTIFY_CLIENT_ID?.trim() ?? "";
}

export function spotifyRedirectPort() {
  const configured = Number(process.env.SPOTIFY_REDIRECT_PORT);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : DEFAULT_SPOTIFY_REDIRECT_PORT;
}

/** Spotify requires the explicit loopback IP, never the localhost hostname. */
export function spotifyRedirectUri() {
  return `http://127.0.0.1:${spotifyRedirectPort()}/callback`;
}

export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-private",
];

export function googleClientId() {
  return process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
}

/** Google issues a secret even for desktop clients, where it is not a secret at all. */
export function googleClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
}

export function googleRedirectPort() {
  const configured = Number(process.env.GOOGLE_REDIRECT_PORT);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : DEFAULT_GOOGLE_REDIRECT_PORT;
}

export function googleRedirectUri() {
  return `http://127.0.0.1:${googleRedirectPort()}/callback`;
}

/**
 * Calendar events may be read and created; mail may be read, archived, and moved to the trash.
 *
 * `gmail.modify` is the narrowest scope Google offers for archiving and trashing — there is no
 * separate permission for either. It would technically also permit sending, which is why the
 * real boundary for mail lives in `gmail.ts`: every request goes through an allowlist of
 * endpoints, and no code path in this repository can reach `messages.send`.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.modify",
];

/**
 * Scopes that exist only to write, send, or hand over the whole mailbox. `gmail.modify` is not
 * among them because it cannot be avoided; `mail.google.com` is, because full access would also
 * allow deleting a message past the trash.
 */
export const GOOGLE_FORBIDDEN_SCOPE_PATTERN =
  /gmail\.(send|compose|insert|settings)|auth\/gmail$|mail\.google\.com/u;

/** Times spoken by the assistant and sent to Google use one configured local time zone. */
export function localTimeZone() {
  const configured = process.env.JARVIS_TIME_ZONE?.trim();
  if (!configured) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: configured });
    return configured;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}
