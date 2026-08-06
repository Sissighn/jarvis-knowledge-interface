/**
 * Google Calendar for the voice assistant: reading the agenda and creating a single event in
 * the primary calendar. Events are never created with attendees and always with
 * `sendUpdates=none`, so entering an appointment cannot send mail to anyone.
 */
import { isRealDay } from "../../features/assistant/local-time";
import { localTimeZone } from "./config";
import { googleRequest } from "./google-auth";
import { LocalActionError } from "./macos";
import { spokenText } from "./text";
import {
  shiftDay,
  startOfDay,
  zonedDate,
  zonedDay,
  zonedInstant,
  zonedWallClock,
  zonedWeekday,
  zonedClock,
} from "./zoned-time";

type CalendarTime = { dateTime?: string; date?: string };
type CalendarEvent = {
  summary?: string;
  location?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  htmlLink?: string;
};

export type AgendaRange = "today" | "tomorrow" | "week";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_SPOKEN_EVENTS = 5;
const MAX_FETCHED_EVENTS = 20;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 12 * 60;

export const DEFAULT_DURATION_MINUTES = 60;

/**
 * Normalizes whatever a small model produced into a local `YYYY-MM-DDTHH:MM`. A date without a
 * time is rejected, because guessing an hour would put a wrong appointment in the calendar.
 */
export function parseLocalDateTime(value: unknown) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})/u.exec(text);
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[T\s,]+(\d{1,2}):(\d{2})/u.exec(text);
  const parts = iso
    ? { year: iso[1], month: iso[2], day: iso[3], hour: iso[4], minute: iso[5] }
    : german
      ? { year: german[3], month: german[2], day: german[1], hour: german[4], minute: german[5] }
      : null;
  if (!parts) return "";

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) return "";

  // A date such as the 30th of February parses but does not exist.
  if (!isRealDay(year, month, day)) return "";
  const padded = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return `${padded}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function clampDuration(value: unknown) {
  const minutes = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^\d]/gu, ""));
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_DURATION_MINUTES;
  return Math.max(MIN_DURATION_MINUTES, Math.min(MAX_DURATION_MINUTES, Math.round(minutes)));
}

function describeEvent(event: CalendarEvent, withWeekday: boolean) {
  const title = spokenText(event.summary) || "Termin ohne Titel";
  if (event.start?.date) {
    const day = new Date(`${event.start.date}T12:00:00Z`);
    return withWeekday ? `${zonedWeekday(day)} ganztägig ${title}` : `ganztägig ${title}`;
  }
  if (!event.start?.dateTime) return title;
  const start = new Date(event.start.dateTime);
  if (Number.isNaN(start.getTime())) return title;
  return withWeekday
    ? `${zonedWeekday(start)} um ${zonedClock(start)} Uhr ${title}`
    : `um ${zonedClock(start)} Uhr ${title}`;
}

function describeAgenda(events: CalendarEvent[], withWeekday: boolean) {
  const spoken = events.slice(0, MAX_SPOKEN_EVENTS).map((event) => describeEvent(event, withWeekday));
  const remaining = events.length - spoken.length;
  return remaining > 0
    ? `${spoken.join(", ")} und ${remaining} ${remaining === 1 ? "weiterer Termin" : "weitere Termine"}`
    : spoken.join(", ");
}

export async function listAgenda(range: AgendaRange) {
  const today = zonedDay(new Date());
  // Today and this week start now, so a meeting that is already over is not read out again.
  const from = range === "tomorrow" ? startOfDay(shiftDay(today, 1)) : new Date();
  const until = range === "today"
    ? startOfDay(shiftDay(today, 1))
    : range === "tomorrow"
      ? startOfDay(shiftDay(today, 2))
      : startOfDay(shiftDay(today, 7));

  const payload = await googleRequest(`${EVENTS_URL}?${new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(MAX_FETCHED_EVENTS),
  })}`) as { items?: CalendarEvent[] } | null;

  const events = payload?.items ?? [];
  return {
    range,
    count: events.length,
    description: describeAgenda(events, range === "week"),
  };
}

export type NewEvent = {
  title: string;
  start: string;
  duration: number;
  location: string;
};

export async function createEvent({ title, start, duration, location }: NewEvent) {
  if (!title) throw new LocalActionError("Für den Termin fehlt noch ein Titel.", 400);
  const normalizedStart = parseLocalDateTime(start);
  if (!normalizedStart) {
    throw new LocalActionError("Für den Termin fehlt noch ein eindeutiges Datum mit Uhrzeit.", 400);
  }

  const [day, time] = normalizedStart.split("T");
  const startInstant = zonedInstant(day, time);
  const endInstant = new Date(startInstant.getTime() + duration * 60_000);
  const timeZone = localTimeZone();

  // No attendees and no notifications: entering an appointment must never mail anybody.
  const created = await googleRequest(`${EVENTS_URL}?${new URLSearchParams({ sendUpdates: "none" })}`, {
    method: "POST",
    body: JSON.stringify({
      summary: title,
      ...(location ? { location } : {}),
      start: { dateTime: `${normalizedStart}:00`, timeZone },
      end: { dateTime: `${zonedWallClock(endInstant)}:00`, timeZone },
    }),
  }) as CalendarEvent | null;

  return {
    created: true,
    title,
    start: normalizedStart,
    duration,
    description: `${title} am ${zonedWeekday(startInstant)}, ${zonedDate(startInstant)} um ${time} Uhr`,
    link: spokenText(created?.htmlLink, 400),
  };
}
