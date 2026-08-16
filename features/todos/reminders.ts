/**
 * Which deadlines deserve a notification right now. The selection is pure and works on the same
 * wall-clock strings as the ordering; sending the notification itself is the desktop layer's job.
 */
import { dueDay, dueTime } from "./ordering";
import type { TodoItem } from "./types";

export const DEFAULT_LEAD_MINUTES = 30;
/** A to-do that names only a day is reminded in the morning, not at midnight. */
const DAY_REMINDER_TIME = "09:00";
/**
 * A closed app misses its reminders. Catching up on the last few hours is useful, replaying two
 * weeks of missed deadlines at launch is not.
 */
const MAX_CATCH_UP_HOURS = 12;
const MAX_PER_CHECK = 3;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * Moves a `YYYY-MM-DDTHH:MM` wall clock by minutes. Both sides of every comparison are wall
 * clock in the same zone, so no conversion is involved and none is wanted.
 */
export function shiftWallClock(value: string, minutes: number) {
  const [day, time = "00:00"] = value.split("T");
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date, hour, minute + minutes));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/** When a to-do should be announced, or `""` when it carries no date at all. */
export function reminderMoment(todo: TodoItem, leadMinutes = DEFAULT_LEAD_MINUTES) {
  if (!todo.due) return "";
  return dueTime(todo.due)
    ? shiftWallClock(todo.due, -leadMinutes)
    : `${dueDay(todo.due)}T${DAY_REMINDER_TIME}`;
}

/** A moved deadline is a new reminder, so the key carries the due value it was sent for. */
export function reminderKey(todo: TodoItem) {
  return `${todo.id}:${todo.due}`;
}

export function pendingReminders(
  todos: TodoItem[],
  now: string,
  notified: ReadonlySet<string>,
  leadMinutes = DEFAULT_LEAD_MINUTES,
) {
  const earliest = shiftWallClock(now, -MAX_CATCH_UP_HOURS * 60);
  return todos
    .filter((todo) => !todo.done && todo.due && !notified.has(reminderKey(todo)))
    .map((todo) => ({ todo, moment: reminderMoment(todo, leadMinutes) }))
    .filter((entry) => entry.moment && entry.moment <= now && entry.moment >= earliest)
    .sort((left, right) => (left.moment < right.moment ? -1 : left.moment > right.moment ? 1 : 0))
    .slice(0, MAX_PER_CHECK)
    .map((entry) => entry.todo);
}
