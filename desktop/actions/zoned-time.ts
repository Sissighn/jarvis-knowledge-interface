/**
 * Wall-clock helpers bound to the configured local time zone. The formatting itself lives in
 * `features/assistant/local-time.ts`, which stays free of locale data because the packaged
 * runtime only ships English one.
 */
import {
  clockTime,
  dateName,
  instantAt,
  isoDay,
  isRealDay,
  shiftIsoDay,
  weekdayName,
} from "../../features/assistant/local-time";
import { localTimeZone } from "./config";

/** German day words the assistant hears far more often than a date. */
const RELATIVE_DAYS: Record<string, number> = {
  heute: 0,
  gestern: -1,
  vorgestern: -2,
  morgen: 1,
  übermorgen: 2,
};

const WEEKDAY_WORDS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];

/** The calendar date in the configured zone, as `YYYY-MM-DD`. */
export function zonedDay(date: Date) {
  return isoDay(date, localTimeZone());
}

export function zonedClock(date: Date) {
  return clockTime(date, localTimeZone());
}

/** Local wall-clock time as `YYYY-MM-DDTHH:MM`, the shape the Calendar API expects. */
export function zonedWallClock(date: Date) {
  return `${zonedDay(date)}T${zonedClock(date)}`;
}

export function zonedWeekday(date: Date) {
  return weekdayName(date, localTimeZone());
}

export function zonedDate(date: Date) {
  return dateName(date, localTimeZone());
}

export function shiftDay(day: string, days: number) {
  return shiftIsoDay(day, days);
}

/** The instant at which a local wall-clock time happens in the configured zone. */
export function zonedInstant(day: string, time: string) {
  return instantAt(day, time, localTimeZone());
}

export function startOfDay(day: string) {
  return zonedInstant(day, "00:00");
}

/** The day a plain `YYYY-MM-DD` refers to, once it is known to exist. */
function isoDayFromParts(year: number, month: number, day: number) {
  if (!isRealDay(year, month, day)) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Normalizes the day a small model produced. Numeric dates are the reliable path, but a spoken
 * question rarely contains one: "gestern" and "am Freitag" arrive far more often, so they are
 * resolved here instead of being handed back as an error the user has to work around.
 *
 * A bare weekday has no direction of its own — for a mail question it is the Friday that has
 * been, for a deadline it is the Friday that comes, so the caller says which one it means.
 */
export function parseLocalDay(value: unknown, reference = new Date(), direction: "past" | "future" = "past") {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";

  const word = text
    .toLowerCase()
    .replace(/[?!.,]+$/u, "")
    .replace(/^(am|an|bis|vom|von|der|den|letzten|letzter|letztes|diesen|dieser|nächsten|naechsten|kommenden|vergangenen)\s+/u, "")
    .trim();
  const today = zonedDay(reference);

  if (word in RELATIVE_DAYS) return shiftDay(today, RELATIVE_DAYS[word]);

  const weekday = WEEKDAY_WORDS.indexOf(word);
  if (weekday >= 0) {
    const [year, month, day] = today.split("-").map(Number);
    const todayWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return direction === "future"
      ? shiftDay(today, (weekday - todayWeekday + 7) % 7)
      : shiftDay(today, -((todayWeekday - weekday + 7) % 7));
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/u.exec(text);
  if (iso) return isoDayFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/u.exec(text);
  if (german) return isoDayFromParts(Number(german[3]), Number(german[2]), Number(german[1]));

  return "";
}
