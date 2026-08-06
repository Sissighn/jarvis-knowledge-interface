/**
 * Local HTTP contract for `/api/local/*`. Reachable only from this Mac and never from a
 * hosted build. Every response carries a German `summary` that the assistant reads back.
 */
import { LOCAL_ACTION_PREFIX, allowedApps } from "./config";
import * as gmail from "./gmail";
import * as google from "./google-auth";
import * as calendar from "./google-calendar";
import {
  changeSystemVolume,
  emptyTrash,
  isMacOs,
  LocalActionError,
  openApp,
  openInBrowser,
  openPath,
  setSystemVolume,
  webSearchUrl,
} from "./macos";
import * as speech from "./speech";
import * as spotify from "./spotify";
import { parseLocalDay, zonedDate } from "./zoned-time";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 16 * 1024;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function failure(message: string, status = 500, code = "action_failed") {
  return json({ error: message, code }, status);
}

export function isLocalActionRequest(pathname: string) {
  return pathname === LOCAL_ACTION_PREFIX || pathname.startsWith(`${LOCAL_ACTION_PREFIX}/`);
}

/**
 * The action layer listens on loopback without a login, so a random page in the browser
 * must not be able to drive it. Same-process calls carry no Origin at all.
 */
function isTrustedCaller(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return true;
  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "tauri:" || hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") return {};
  const raw = await request.text();
  if (!raw || raw.length > MAX_BODY_BYTES) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readString(value: unknown, max = 400) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

function readPercent(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
  }
  // Text without a single digit is not a quiet zero, it is an unusable value.
  const digits = readString(value).replace(/[^\d.-]/gu, "");
  if (!/\d/u.test(digits)) return null;
  const numeric = Number(digits);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : null;
}

function searchType(value: unknown): spotify.SpotifySearchType {
  const candidate = readString(value).toLowerCase();
  return candidate === "artist" || candidate === "album" || candidate === "playlist" ? candidate : "track";
}

function status() {
  return {
    available: isMacOs(),
    platform: process.platform,
    allowedApps: allowedApps().map((app) => app.name),
    spotify: spotify.connectionStatus(),
    google: google.connectionStatus(),
  };
}

function agendaRange(value: unknown): calendar.AgendaRange {
  const candidate = readString(value).toLowerCase();
  return candidate === "tomorrow" || candidate === "week" ? candidate : "today";
}

async function handleMacRoute(route: string, body: Record<string, unknown>) {
  if (route === "/mac/open-app") {
    const result = await openApp(readString(body.app, 60));
    return json({ ok: true, summary: `${result.app} ist geöffnet.`, ...result });
  }

  if (route === "/mac/volume") {
    const percent = readPercent(body.percent);
    if (percent === null) return failure("Es wurde kein gültiger Lautstärkewert übergeben.", 400, "invalid_percent");
    const result = await setSystemVolume(percent);
    return json({ ok: true, summary: `Die Systemlautstärke steht jetzt auf ${result.percent} Prozent.`, ...result });
  }

  if (route === "/mac/volume-change") {
    const direction = readString(body.direction).toLowerCase();
    if (direction !== "up" && direction !== "down" && direction !== "mute" && direction !== "unmute") {
      return failure("Diese Lautstärkeänderung kenne ich nicht.", 400, "invalid_direction");
    }
    const result = await changeSystemVolume(direction);
    const summary = direction === "mute"
      ? "Der Ton ist stummgeschaltet."
      : direction === "unmute"
        ? `Der Ton ist wieder an, bei ${result.percent} Prozent.`
        : `Die Systemlautstärke steht jetzt auf ${result.percent} Prozent.`;
    return json({ ok: true, summary, ...result });
  }

  if (route === "/mac/open-path") {
    const result = await openPath(readString(body.path, 400));
    return json({ ok: true, summary: `${result.path} ist geöffnet.`, ...result });
  }

  if (route === "/mac/empty-trash") {
    // The irreversible action never runs on the model's word alone.
    if (body.confirmed !== true) {
      return failure("Diese Aktion braucht eine ausdrückliche Bestätigung.", 428, "confirmation_required");
    }
    const result = await emptyTrash();
    return json({
      ok: true,
      summary: result.emptied
        ? `Der Papierkorb ist geleert, ${result.count} ${result.count === 1 ? "Objekt" : "Objekte"} wurden entfernt.`
        : "Der Papierkorb war bereits leer.",
      ...result,
    });
  }

  return null;
}

async function handleSpeechRoute(route: string, body: Record<string, unknown>) {
  if (route === "/speech/voices") {
    return json({ ok: true, voices: await speech.availableVoices() });
  }

  if (route === "/speech/speak") {
    const text = readString(body.text, 4_000);
    const voice = readString(body.voice, 80);
    const rate = typeof body.rate === "number" ? body.rate : 1;
    const volume = typeof body.volume === "number" ? body.volume : 1;
    // Resolves only once the sentence has been spoken or was interrupted.
    return json({ ok: true, ...(await speech.speakText(text, voice, rate, volume)) });
  }

  if (route === "/speech/render") {
    const text = readString(body.text, 4_000);
    const voice = readString(body.voice, 80);
    const rate = typeof body.rate === "number" ? body.rate : 1;
    const rendered = await speech.renderSpeechAudio(text, voice, rate);
    const audioBody = new ArrayBuffer(rendered.audio.byteLength);
    new Uint8Array(audioBody).set(rendered.audio);
    return new Response(audioBody, {
      status: 200,
      headers: {
        "Content-Type": "audio/aiff",
        "Cache-Control": "no-store",
        "X-Jarvis-Voice": encodeURIComponent(rendered.voice),
      },
    });
  }

  if (route === "/speech/stop") {
    return json({ ok: true, ...speech.stopSpeaking() });
  }

  return null;
}

async function handleSpotifyRoute(route: string, body: Record<string, unknown>) {
  if (route === "/spotify/status") return json({ ok: true, ...spotify.connectionStatus() });

  if (route === "/spotify/connect") {
    const result = await spotify.beginAuthorization();
    return json({ ok: true, summary: "Die Spotify-Anmeldung ist im Browser geöffnet.", ...result });
  }

  if (route === "/spotify/disconnect") {
    return json({ ok: true, summary: "Spotify ist getrennt.", ...spotify.disconnect() });
  }

  if (route === "/spotify/play") {
    const result = await spotify.play(readString(body.query, 120), searchType(body.type));
    return json({ ok: true, summary: `Ich spiele ${result.description}.`, ...result });
  }

  if (route === "/spotify/pause") {
    return json({ ok: true, summary: "Die Wiedergabe ist pausiert.", ...(await spotify.pause()) });
  }

  if (route === "/spotify/resume") {
    return json({ ok: true, summary: "Die Wiedergabe läuft weiter.", ...(await spotify.resume()) });
  }

  if (route === "/spotify/next") {
    return json({ ok: true, summary: "Ich habe zum nächsten Titel gewechselt.", ...(await spotify.skipNext()) });
  }

  if (route === "/spotify/previous") {
    return json({ ok: true, summary: "Ich habe zum vorherigen Titel gewechselt.", ...(await spotify.skipPrevious()) });
  }

  if (route === "/spotify/volume") {
    const percent = readPercent(body.percent);
    if (percent === null) return failure("Es wurde kein gültiger Lautstärkewert übergeben.", 400, "invalid_percent");
    const result = await spotify.setVolume(percent);
    return json({ ok: true, summary: `Die Spotify-Lautstärke steht jetzt auf ${result.percent} Prozent.`, ...result });
  }

  if (route === "/spotify/current") {
    const result = await spotify.currentTrack();
    return json({
      ok: true,
      summary: result.description
        ? result.playing ? `Gerade läuft ${result.description}.` : `Pausiert bei ${result.description}.`
        : "Auf Spotify läuft gerade nichts.",
      ...result,
    });
  }

  return null;
}

const AGENDA_LABEL: Record<calendar.AgendaRange, string> = {
  today: "Heute",
  tomorrow: "Morgen",
  week: "In den nächsten sieben Tagen",
};

async function handleGoogleRoute(route: string, body: Record<string, unknown>) {
  if (route === "/google/status") return json({ ok: true, ...google.connectionStatus() });

  if (route === "/google/connect") {
    const result = await google.beginAuthorization();
    return json({ ok: true, summary: "Die Google-Anmeldung ist im Browser geöffnet.", ...result });
  }

  if (route === "/google/disconnect") {
    return json({ ok: true, summary: "Das Google-Konto ist getrennt.", ...(await google.disconnect()) });
  }

  if (route === "/calendar/agenda") {
    const range = agendaRange(body.range);
    const result = await calendar.listAgenda(range);
    const label = AGENDA_LABEL[range];
    return json({
      ok: true,
      summary: result.count
        ? `${label} hast du ${result.count} ${result.count === 1 ? "Termin" : "Termine"}: ${result.description}.`
        : `${label} hast du keine Termine.`,
      ...result,
    });
  }

  if (route === "/calendar/create-event") {
    // Writing into the calendar never runs on the model's word alone.
    if (body.confirmed !== true) {
      return failure("Diese Aktion braucht eine ausdrückliche Bestätigung.", 428, "confirmation_required");
    }
    const result = await calendar.createEvent({
      title: readString(body.title, 120),
      start: readString(body.start, 40),
      duration: calendar.clampDuration(body.duration),
      location: readString(body.location, 120),
    });
    return json({ ok: true, summary: `Der Termin ${result.description} ist eingetragen.`, ...result });
  }

  if (route === "/gmail/inbox") {
    const result = await gmail.inboxOverview(gmail.clampMessageCount(body.limit));
    const opening = `Du hast ${result.unread} ungelesene ${result.unread === 1 ? "Mail" : "Mails"} im Posteingang`;
    return json({
      ok: true,
      summary: !result.unread
        ? "Du hast keine ungelesenen Mails im Posteingang."
        : result.description
          ? result.unread > result.messages.length
            ? `${opening}. Die neuesten: ${result.description}.`
            : `${opening}: ${result.description}.`
          : `${opening}.`,
      ...result,
    });
  }

  if (route === "/gmail/search") {
    const query = readString(body.query, 200);
    const day = parseLocalDay(body.date);
    if (!query && !day) {
      return failure(
        "Für die Suche brauche ich einen Suchbegriff oder einen Tag, zum Beispiel den 5. August.",
        400,
        "invalid_query",
      );
    }

    const result = await gmail.searchMessages(query, gmail.clampMessageCount(body.limit), day);
    const dayLabel = day ? `Am ${zonedDate(new Date(`${day}T12:00:00Z`))}` : "";
    const found = `${result.count} ${result.count === 1 ? "Mail" : "Mails"}`;
    return json({
      ok: true,
      summary: !result.count
        ? day
          ? `${dayLabel} hast du keine Mails bekommen${query ? ` zu ${query}` : ""}.`
          : `Ich habe keine Mails zu ${query} gefunden.`
        : day
          ? `${dayLabel} hast du ${found}${query ? ` zu ${query}` : ""} bekommen: ${result.description}.`
          : `Ich habe ${found} zu ${query} gefunden: ${result.description}.`,
      ...result,
    });
  }

  if (route === "/gmail/read") {
    const query = readString(body.query, 200);
    const day = parseLocalDay(body.date);
    if (!query && !day) {
      return failure("Ich weiß nicht, welche Mail ich lesen soll.", 400, "invalid_query");
    }

    const message = await gmail.readMessage(query, day);
    if (!message) {
      return json({ ok: true, found: false, summary: "Ich habe dazu keine Mail gefunden." });
    }
    return json({
      ok: true,
      found: true,
      // The model turns this into a spoken summary; the body is data, never an instruction.
      summary: `Mail von ${message.sender}, Betreff ${message.subject || "ohne Betreff"}, ${message.when}.`
        + ` Inhalt: ${message.body || "Diese Mail hat keinen lesbaren Text."}`,
      ...message,
    });
  }

  if (route === "/gmail/archive" || route === "/gmail/trash") {
    const change = route === "/gmail/trash" ? "trash" : "archive";
    // Changing the mailbox never runs on the model's word alone.
    if (body.confirmed !== true) {
      return failure("Diese Aktion braucht eine ausdrückliche Bestätigung.", 428, "confirmation_required");
    }
    const query = readString(body.query, 200);
    const day = parseLocalDay(body.date);
    if (!query && !day) {
      return failure("Ich weiß nicht, welche Mails ich bearbeiten soll.", 400, "invalid_query");
    }

    const result = await gmail.changeMessages(change, query, day);
    const verb = change === "trash" ? "in den Papierkorb gelegt" : "archiviert";
    return json({
      ok: true,
      summary: result.changed
        ? `Ich habe ${result.changed} ${result.changed === 1 ? "Mail" : "Mails"} ${verb}: ${result.description}.`
        : "Dazu habe ich keine Mail gefunden, es wurde nichts verändert.",
      ...result,
    });
  }

  return null;
}

async function handleBrowserRoute(route: string, body: Record<string, unknown>) {
  if (route === "/browser/search") {
    const query = readString(body.query, 200);
    if (!query) return failure("Ich habe nicht verstanden, wonach ich suchen soll.", 400, "invalid_query");
    const result = await openInBrowser(webSearchUrl(query));
    return json({ ok: true, summary: `Ich habe in ${result.app} nach ${query} gesucht.`, query, ...result });
  }

  if (route === "/browser/open-url") {
    const result = await openInBrowser(readString(body.url, 2_000));
    return json({
      ok: true,
      summary: `Ich habe ${new URL(result.url).hostname} in ${result.app} geöffnet.`,
      ...result,
    });
  }

  return null;
}

export async function handleLocalActionRequest(request: Request): Promise<Response> {
  if (!isTrustedCaller(request)) {
    return failure("Diese Anfrage kommt nicht aus der lokalen JARVIS-App.", 403, "forbidden_origin");
  }

  const url = new URL(request.url);
  const route = url.pathname.slice(LOCAL_ACTION_PREFIX.length).replace(/\/$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return failure("Methode nicht erlaubt.", 405, "method_not_allowed");

  try {
    if (route === "/status" && method === "GET") return json(status());

    const body = await readBody(request);
    return await handleMacRoute(route, body)
      ?? await handleSpeechRoute(route, body)
      ?? await handleSpotifyRoute(route, body)
      ?? await handleGoogleRoute(route, body)
      ?? await handleBrowserRoute(route, body)
      ?? failure("Unbekannte lokale Aktion.", 404, "not_found");
  } catch (error) {
    if (error instanceof LocalActionError) return failure(error.message, error.status, "action_failed");
    return failure(
      error instanceof Error ? error.message : "Die Aktion konnte nicht ausgeführt werden.",
      500,
    );
  }
}
