/**
 * German date wording for deadlines. Everything here works on wall-clock strings and our own
 * words: the packaged runtime ships no German locale data, so a formatted pattern is never
 * an option — not in the panel, and not in a spoken sentence.
 */
import { shiftIsoDay } from "../assistant/local-time";
import { dueDay, dueTime } from "./ordering";

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const WEEKDAYS_SHORT = ["SO", "MO", "DI", "MI", "DO", "FR", "SA"];
const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];
const MONTHS_SHORT = ["JAN", "FEB", "MRZ", "APR", "MAI", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEZ"];

/** The weekday of a `YYYY-MM-DD` day, independent of any time zone. */
export function weekdayIndex(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

export function weekdayShort(day: string) {
  return WEEKDAYS_SHORT[weekdayIndex(day)] ?? "";
}

export function monthTitle(year: number, month: number) {
  return `${MONTHS[month - 1] ?? ""} ${year}`;
}

export function dayTitle(day: string) {
  const [, month, date] = day.split("-").map(Number);
  return `${WEEKDAYS[weekdayIndex(day)]}, ${date}. ${MONTHS[month - 1]}`;
}

/** The compact badge the panel shows next to a task: `HEUTE 15:00`, `FR`, `14. AUG`. */
export function dueBadge(due: string, now: string) {
  if (!due) return "";
  const day = dueDay(due);
  const time = dueTime(due);
  const today = now.slice(0, 10);
  const clock = time ? ` ${time}` : "";

  if (day === today) return `HEUTE${clock}`;
  if (day === shiftIsoDay(today, 1)) return `MORGEN${clock}`;
  if (day === shiftIsoDay(today, -1)) return `GESTERN${clock}`;
  if (day > today && day <= shiftIsoDay(today, 6)) return `${weekdayShort(day)}${clock}`;

  const [year, month, date] = day.split("-").map(Number);
  // A deadline from another year has to say so, otherwise it reads like this year's date.
  const suffix = year === Number(now.slice(0, 4)) ? "" : ` ${String(year).slice(2)}`;
  return `${date}. ${MONTHS_SHORT[month - 1]}${suffix}${clock}`;
}

/** The spoken form of a deadline: a person says "morgen um 15 Uhr", not an ISO timestamp. */
export function dueSentence(due: string, now: string) {
  if (!due) return "";
  const day = dueDay(due);
  const time = dueTime(due);
  const today = now.slice(0, 10);
  const clock = time ? ` um ${time} Uhr` : "";

  if (day === today) return `heute${clock}`;
  if (day === shiftIsoDay(today, 1)) return `morgen${clock}`;
  if (day === shiftIsoDay(today, -1)) return `gestern${clock}`;
  if (day > today && day <= shiftIsoDay(today, 6)) return `am ${WEEKDAYS[weekdayIndex(day)]}${clock}`;

  const [year, month, date] = day.split("-").map(Number);
  const suffix = year === Number(now.slice(0, 4)) ? "" : ` ${year}`;
  return `am ${date}. ${MONTHS[month - 1]}${suffix}${clock}`;
}

/** The days of the month grid, Monday first, padded with the surrounding weeks. */
export function monthGrid(year: number, month: number) {
  const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  // Monday is column zero, so Sunday has to become the last day of the week, not the first.
  const lead = (weekdayIndex(first) + 6) % 7;
  const start = shiftIsoDay(first, -lead);
  return Array.from({ length: 42 }, (_, index) => shiftIsoDay(start, index));
}
