/**
 * Wall-clock helpers that do not depend on locale data.
 *
 * The packaged desktop runtime is a `small-icu` Node build: it knows time zones, but its only
 * locale is English. `Intl.DateTimeFormat("en-CA", …)` therefore returns `08/06/2026` instead of
 * `2026-08-06` there, and `de-DE` weekdays come back as "Thursday". Anything that reads a
 * formatted date back, or that speaks German, has to be built from typed numeric parts and our
 * own words — never from a locale pattern.
 */

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function pad(value: number, length = 2) {
  return String(value).padStart(length, "0");
}

/** The numeric wall clock in a zone. Only typed parts are read, so the pattern cannot matter. */
export function wallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

export function isoDay(date: Date, timeZone: string) {
  const { year, month, day } = wallClock(date, timeZone);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function clockTime(date: Date, timeZone: string) {
  const { hour, minute } = wallClock(date, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

export function weekdayName(date: Date, timeZone: string) {
  const { year, month, day } = wallClock(date, timeZone);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** The spoken date without a year, for example `5. August`. */
export function dateName(date: Date, timeZone: string) {
  const { month, day } = wallClock(date, timeZone);
  return `${day}. ${MONTHS[month - 1]}`;
}

/** The full moment the assistant is told about, for example `Donnerstag, 06. August 2026, 14:32`. */
export function momentName(date: Date, timeZone: string) {
  const { year, month, day, hour, minute } = wallClock(date, timeZone);
  return `${weekdayName(date, timeZone)}, ${pad(day)}. ${MONTHS[month - 1]} ${year}, ${pad(hour)}:${pad(minute)}`;
}

/** Milliseconds the zone is ahead of UTC at that instant. */
export function offsetMilliseconds(date: Date, timeZone: string) {
  const { year, month, day, hour, minute, second } = wallClock(date, timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(date.getTime() / 1000) * 1000;
}

export function shiftIsoDay(day: string, days: number) {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * The instant at which a local wall-clock time happens. The offset is resolved twice, because the
 * one that applies is the offset at the resulting instant, not the offset at the same clock in UTC.
 */
export function instantAt(day: string, time: string, timeZone: string) {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, date, hour, minute);
  const guess = naive - offsetMilliseconds(new Date(naive), timeZone);
  return new Date(naive - offsetMilliseconds(new Date(guess), timeZone));
}

/** Whether a calendar date exists at all; the 30th of February parses but does not. */
export function isRealDay(year: number, month: number, day: number) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}
