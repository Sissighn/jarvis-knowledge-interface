import assert from "node:assert/strict";
import test from "node:test";
import { handleLocalActionRequest } from "../../desktop/actions/api";
import { GOOGLE_FORBIDDEN_SCOPE_PATTERN, GOOGLE_SCOPES } from "../../desktop/actions/config";
import {
  buildSearchQuery,
  clampMessageCount,
  describeMails,
  gmailCall,
  receivedLabel,
  senderName,
} from "../../desktop/actions/gmail";
import { clampDuration, parseLocalDateTime } from "../../desktop/actions/google-calendar";
import { LocalActionError, normalizeWebUrl, webSearchUrl } from "../../desktop/actions/macos";
import { spokenText } from "../../desktop/actions/text";
import { parseLocalDay } from "../../desktop/actions/zoned-time";
import {
  clockTime,
  dateName,
  instantAt,
  isoDay,
  momentName,
  shiftIsoDay,
  weekdayName,
} from "../../features/assistant/local-time";

function post(path: string, body: unknown) {
  return new Request(`http://127.0.0.1:4318/api/local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the requested Google access stops short of sending and of full mailbox access", () => {
  assert.deepEqual(GOOGLE_SCOPES, [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.modify",
  ]);
  for (const scope of GOOGLE_SCOPES) {
    assert.equal(GOOGLE_FORBIDDEN_SCOPE_PATTERN.test(scope), false, `${scope} has to stay grantable`);
  }
  // Scopes that exist only to send, to draft, or to hand over everything.
  for (const forbidden of [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.insert",
    "https://mail.google.com/",
  ]) {
    assert.ok(GOOGLE_FORBIDDEN_SCOPE_PATTERN.test(forbidden), `${forbidden} must be refused`);
  }
});

test("no Gmail endpoint outside the allowlist can be reached", async () => {
  // gmail.modify would permit sending, so the boundary is the endpoint list, not the scope.
  // Reaching a forbidden path has to fail before any token is used or any request is built.
  for (const [method, path] of [
    ["POST", "/messages/send"],
    ["POST", "/messages/abc123/send"],
    ["POST", "/drafts"],
    ["POST", "/drafts/send"],
    ["DELETE", "/messages/abc123"],
    ["POST", "/messages/abc123/untrash"],
    ["GET", "/settings/forwarding"],
  ] as const) {
    await assert.rejects(
      () => gmailCall(path, method),
      (error: unknown) => error instanceof LocalActionError && error.status === 403,
      `${method} ${path} must be refused`,
    );
  }
});

test("archiving and trashing never run without an explicit confirmation", async () => {
  for (const route of ["/gmail/archive", "/gmail/trash"]) {
    const response = await handleLocalActionRequest(post(route, { query: "Newsletter" }));
    assert.equal(response.status, 428, `${route} must ask first`);
    assert.equal((await response.json() as { code: string }).code, "confirmation_required");
  }
});

test("a mail command without a target changes nothing", async () => {
  for (const route of ["/gmail/archive", "/gmail/trash"]) {
    const response = await handleLocalActionRequest(post(route, { confirmed: true }));
    assert.equal(response.status, 400, `${route} must know what it touches`);
    assert.equal((await response.json() as { code: string }).code, "invalid_query");
  }
});

test("a new appointment never runs without an explicit confirmation", async () => {
  const response = await handleLocalActionRequest(post("/calendar/create-event", {
    title: "Zahnarzt",
    start: "2026-03-14T15:00",
  }));
  const payload = await response.json() as { code: string };

  assert.equal(response.status, 428);
  assert.equal(payload.code, "confirmation_required");
});

test("a confirmed appointment without a usable time is refused before Google is called", async () => {
  const response = await handleLocalActionRequest(post("/calendar/create-event", {
    title: "Zahnarzt",
    start: "irgendwann nächste Woche",
    confirmed: true,
  }));
  const payload = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.match(payload.error, /Datum mit Uhrzeit/u);
});

test("a mail search without a search term and without a day is refused", async () => {
  const response = await handleLocalActionRequest(post("/gmail/search", { query: "   " }));
  const payload = await response.json() as { code: string; error: string };

  assert.equal(response.status, 400);
  assert.equal(payload.code, "invalid_query");
  // The spoken error has to say what is missing, because the assistant reads it out as is.
  assert.match(payload.error, /Suchbegriff oder einen Tag/u);
});

test("a day alone is a complete mail search", () => {
  // „Habe ich am 5. August Mails bekommen?“ carries no search term at all.
  const dayOnly = buildSearchQuery("", "2026-08-05");
  const from = Math.floor(new Date("2026-08-05T00:00:00+02:00").getTime() / 1000);
  const until = Math.floor(new Date("2026-08-06T00:00:00+02:00").getTime() / 1000);

  assert.equal(dayOnly, `-in:sent -in:drafts -in:chats after:${from} before:${until}`);
  // Own mail never counts as something that arrived.
  assert.match(buildSearchQuery("Rechnung", ""), /^Rechnung -in:sent -in:drafts -in:chats$/u);
  assert.ok(buildSearchQuery("Rechnung", "2026-08-05").startsWith("Rechnung "));
});

test("reads the calendar days a small model produces", () => {
  assert.equal(parseLocalDay("2026-08-05"), "2026-08-05");
  assert.equal(parseLocalDay("2026-8-5"), "2026-08-05");
  assert.equal(parseLocalDay("05.08.2026"), "2026-08-05");
  assert.equal(parseLocalDay("2026-08-05T00:00"), "2026-08-05");
  assert.equal(parseLocalDay("2026-02-30"), "");
  assert.equal(parseLocalDay("5. August"), "");
  assert.equal(parseLocalDay(""), "");
});

test("a spoken day word is a day too", () => {
  // Thursday, 6 August 2026, 12:00 in Berlin.
  const reference = new Date("2026-08-06T10:00:00Z");

  assert.equal(parseLocalDay("heute", reference), "2026-08-06");
  assert.equal(parseLocalDay("gestern", reference), "2026-08-05");
  assert.equal(parseLocalDay("Vorgestern", reference), "2026-08-04");
  assert.equal(parseLocalDay("morgen", reference), "2026-08-07");
  // A named weekday means the one that already happened, today included.
  assert.equal(parseLocalDay("am Montag", reference), "2026-08-03");
  assert.equal(parseLocalDay("letzten Freitag", reference), "2026-07-31");
  assert.equal(parseLocalDay("Donnerstag", reference), "2026-08-06");
  assert.equal(parseLocalDay("irgendwann", reference), "");
});

test("dates survive a runtime without German locale data", () => {
  // The packaged sidecar is small-icu: no locale may decide how a date is built or spoken.
  const instant = new Date("2026-08-06T10:00:00Z");

  assert.equal(isoDay(instant, "Europe/Berlin"), "2026-08-06");
  assert.equal(clockTime(instant, "Europe/Berlin"), "12:00");
  assert.equal(weekdayName(instant, "Europe/Berlin"), "Donnerstag");
  assert.equal(dateName(instant, "Europe/Berlin"), "6. August");
  assert.equal(momentName(instant, "Europe/Berlin"), "Donnerstag, 06. August 2026, 12:00");
  assert.equal(shiftIsoDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftIsoDay("2026-03-01", -1), "2026-02-28");
  // Midnight local time is 22:00 UTC in summer and 23:00 UTC in winter.
  assert.equal(instantAt("2026-08-06", "00:00", "Europe/Berlin").toISOString(), "2026-08-05T22:00:00.000Z");
  assert.equal(instantAt("2026-01-06", "00:00", "Europe/Berlin").toISOString(), "2026-01-05T23:00:00.000Z");
  // The clock jumps forward at 02:00 on the last Sunday in March.
  assert.equal(instantAt("2026-03-29", "03:00", "Europe/Berlin").toISOString(), "2026-03-29T01:00:00.000Z");
});

test("parses the timestamps a small model produces and rejects the rest", () => {
  assert.equal(parseLocalDateTime("2026-03-14T15:00"), "2026-03-14T15:00");
  assert.equal(parseLocalDateTime("2026-03-14 15:00:00"), "2026-03-14T15:00");
  assert.equal(parseLocalDateTime("2026-03-14T15:00:00+01:00"), "2026-03-14T15:00");
  assert.equal(parseLocalDateTime("14.03.2026 9:05"), "2026-03-14T09:05");
  // A date alone would put the appointment at an invented hour.
  assert.equal(parseLocalDateTime("2026-03-14"), "");
  assert.equal(parseLocalDateTime("2026-02-30T10:00"), "");
  assert.equal(parseLocalDateTime("2026-03-14T25:00"), "");
  assert.equal(parseLocalDateTime("morgen um drei"), "");
  assert.equal(parseLocalDateTime(undefined), "");
});

test("keeps an appointment length inside a sane range", () => {
  assert.equal(clampDuration(undefined), 60);
  assert.equal(clampDuration(90), 90);
  assert.equal(clampDuration("45 Minuten"), 45);
  assert.equal(clampDuration(0), 60);
  assert.equal(clampDuration(5_000), 720);
});

test("only plain web addresses may be opened in the browser", () => {
  assert.equal(normalizeWebUrl("wikipedia.org"), "https://wikipedia.org/");
  assert.equal(normalizeWebUrl(" https://example.com/a?b=c "), "https://example.com/a?b=c");
  assert.throws(() => normalizeWebUrl("javascript:alert(1)"), LocalActionError);
  assert.throws(() => normalizeWebUrl("file:///etc/passwd"), LocalActionError);
  assert.throws(() => normalizeWebUrl("ftp://example.com"), LocalActionError);
  assert.throws(() => normalizeWebUrl(""), LocalActionError);
  assert.equal(webSearchUrl("neue Mac Modelle & mehr"), "https://www.google.com/search?q=neue+Mac+Modelle+%26+mehr");
});

test("mail metadata becomes something a voice can read out", () => {
  assert.equal(senderName('"Anna Müller" <anna@example.com>'), "Anna Müller");
  assert.equal(senderName("=?UTF-8?B?QW5uYSBNw7xsbGVy?= <anna@example.com>"), "Anna Müller");
  assert.equal(senderName("=?UTF-8?Q?Anna_M=C3=BCller?= <anna@example.com>"), "Anna Müller");
  assert.equal(senderName("noreply@example.com"), "noreply@example.com");
  assert.equal(
    describeMails([{ id: "1", sender: "GitHub", subject: "Security alert", when: "heute um 09:10" }]),
    "von GitHub, über Security alert, heute um 09:10",
  );
  assert.equal(receivedLabel("nicht datiert"), "");
  assert.match(receivedLabel(Date.now()), /^heute um \d{2}:\d{2}$/u);
});

test("account text stays a single harmless line", () => {
  assert.equal(spokenText("Betreff\nmit\tZeilen"), "Betreff mit Zeilen");
  assert.equal(spokenText("a".repeat(200), 10), "aaaaaaaaaa");
  assert.equal(spokenText(undefined), "");
});

test("counts the assistant reads out stay small", () => {
  assert.equal(clampMessageCount(undefined), 3);
  assert.equal(clampMessageCount(99), 5);
  assert.equal(clampMessageCount(1), 1);
  assert.equal(clampMessageCount("zwei"), 3);
});
