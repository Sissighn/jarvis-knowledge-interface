/**
 * Allowlisted macOS actions. Every command runs through execFile with an argument list,
 * so no spoken text ever reaches a shell.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { homeDirectory, resolveAllowedApp } from "./config";

const run = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;
const VOLUME_STEP = 10;

export class LocalActionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "LocalActionError";
    this.status = status;
  }
}

export function isMacOs() {
  return process.platform === "darwin";
}

function requireMacOs() {
  if (!isMacOs()) throw new LocalActionError("Aktionen auf dem System gibt es nur unter macOS.", 503);
}

async function osascript(script: string) {
  requireMacOs();
  try {
    const { stdout } = await run("osascript", ["-e", script], { timeout: COMMAND_TIMEOUT_MS });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/-1743|not authori[sz]ed|nicht berechtigt/i.test(message)) {
      throw new LocalActionError(
        "macOS hat die Automatisierung nicht erlaubt. Erlaube JARVIS die Steuerung in den Systemeinstellungen unter Datenschutz und Sicherheit.",
        403,
      );
    }
    throw new LocalActionError("Der Mac hat die Aktion nicht ausgeführt.", 500);
  }
}

export async function openApp(spokenName: string) {
  requireMacOs();
  const app = resolveAllowedApp(spokenName);
  if (!app) {
    throw new LocalActionError(`Das Programm ${spokenName || "ohne Namen"} ist nicht freigegeben.`, 403);
  }
  try {
    await run("open", ["-a", app.name], { timeout: COMMAND_TIMEOUT_MS });
    return { app: app.name };
  } catch {
    throw new LocalActionError(`${app.name} konnte nicht geöffnet werden. Ist es installiert?`, 404);
  }
}

export async function currentVolume() {
  const [volume, muted] = await Promise.all([
    osascript("output volume of (get volume settings)"),
    osascript("output muted of (get volume settings)"),
  ]);
  const percent = Number(volume);
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
    muted: muted === "true",
  };
}

export async function setSystemVolume(percent: number) {
  const target = Math.max(0, Math.min(100, Math.round(percent)));
  await osascript(`set volume output volume ${target}`);
  if (target > 0) await osascript("set volume without output muted");
  return { percent: target, muted: target === 0 };
}

export async function changeSystemVolume(direction: "up" | "down" | "mute" | "unmute") {
  if (direction === "mute") {
    await osascript("set volume with output muted");
    return { ...(await currentVolume()), muted: true };
  }
  if (direction === "unmute") {
    await osascript("set volume without output muted");
    return { ...(await currentVolume()), muted: false };
  }
  const current = await currentVolume();
  const step = direction === "up" ? VOLUME_STEP : -VOLUME_STEP;
  return setSystemVolume(current.percent + step);
}

/** Only paths inside the personal home directory may be opened. */
export function resolveHomePath(rawPath: string) {
  const home = homeDirectory();
  const expanded = rawPath.startsWith("~")
    ? resolve(home, rawPath.replace(/^~\/?/u, ""))
    : isAbsolute(rawPath) ? resolve(rawPath) : resolve(home, rawPath);
  if (!existsSync(expanded)) {
    throw new LocalActionError(`Ich finde ${rawPath} auf diesem Mac nicht.`, 404);
  }
  // realpath closes the door on symlinks that would point outside the home directory.
  const real = realpathSync(expanded);
  const realHome = realpathSync(home);
  if (real !== realHome && !real.startsWith(`${realHome}/`)) {
    throw new LocalActionError("Ich darf nur Dateien und Ordner in deinem Benutzerordner öffnen.", 403);
  }
  return real;
}

export async function openPath(rawPath: string) {
  requireMacOs();
  const path = resolveHomePath(rawPath);
  try {
    await run("open", [path], { timeout: COMMAND_TIMEOUT_MS });
    return { path };
  } catch {
    throw new LocalActionError(`${rawPath} konnte nicht geöffnet werden.`, 500);
  }
}

export async function trashItemCount() {
  const raw = await osascript('tell application "Finder" to count items of trash');
  const count = Number(raw);
  return Number.isFinite(count) ? count : 0;
}

export async function emptyTrash() {
  const count = await trashItemCount();
  if (!count) return { emptied: false, count: 0 };
  await osascript('tell application "Finder" to empty trash');
  return { emptied: true, count };
}

/** Only the two login screens may be opened by the action layer itself. */
const AUTHORIZATION_URL_PATTERN = /^https:\/\/accounts\.(spotify|google)\.com\//u;

/** Opens a URL in the default browser, used for the Spotify and Google logins. */
export async function openExternalUrl(url: string) {
  requireMacOs();
  if (!AUTHORIZATION_URL_PATTERN.test(url)) {
    throw new LocalActionError("Diese Adresse darf nicht geöffnet werden.", 403);
  }
  await run("open", [url], { timeout: COMMAND_TIMEOUT_MS });
}

/**
 * Turns spoken text into an address that may be opened. Everything that is not plain web
 * traffic is rejected, so no `file:`, `javascript:`, or custom scheme ever reaches `open`.
 */
export function normalizeWebUrl(rawUrl: string) {
  const text = rawUrl.trim();
  if (!text) throw new LocalActionError("Ich habe keine Adresse verstanden.", 400);

  const candidate = /^[a-z][\w+.-]*:/iu.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new LocalActionError(`${rawUrl} ist keine gültige Internetadresse.`, 400);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new LocalActionError("Ich öffne nur Adressen mit http oder https.", 403);
  }
  if (!parsed.hostname.includes(".")) {
    throw new LocalActionError(`${rawUrl} ist keine gültige Internetadresse.`, 400);
  }
  return parsed.toString();
}

export function webSearchUrl(query: string) {
  return `https://www.google.com/search?${new URLSearchParams({ q: query })}`;
}

/**
 * Opens a web address in whatever browser this Mac uses by default. This is the path behind a
 * link the user clicked in the interface: the packaged webview refuses to open a second window
 * of its own, and a clicked link belongs in the user's own browser, not necessarily in Chrome.
 */
export async function openLink(url: string) {
  requireMacOs();
  const target = normalizeWebUrl(url);
  try {
    await run("open", [target], { timeout: COMMAND_TIMEOUT_MS });
    return { url: target };
  } catch {
    throw new LocalActionError("Der Mac konnte die Adresse nicht öffnen.", 500);
  }
}

/** Opens an address in an allowlisted browser, by default in Google Chrome. */
export async function openInBrowser(url: string, browser = "Google Chrome") {
  requireMacOs();
  const app = resolveAllowedApp(browser);
  if (!app) throw new LocalActionError(`Der Browser ${browser} ist nicht freigegeben.`, 403);
  const target = normalizeWebUrl(url);
  try {
    await run("open", ["-a", app.name, target], { timeout: COMMAND_TIMEOUT_MS });
    return { app: app.name, url: target };
  } catch {
    throw new LocalActionError(`${app.name} konnte nicht geöffnet werden. Ist es installiert?`, 404);
  }
}
