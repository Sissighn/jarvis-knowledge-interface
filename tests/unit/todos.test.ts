import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { dueBadge, dueSentence, monthGrid, weekdayShort } from "../../features/todos/format";
import { findTodo, findTodoOrStep, matchScore } from "../../features/todos/matching";
import { orderTodos, todoCounts, todoUrgency } from "../../features/todos/ordering";
import { pendingReminders, reminderKey, reminderMoment, shiftWallClock } from "../../features/todos/reminders";
import type { TodoItem } from "../../features/todos/types";

// The action layer writes a real file, so it gets a directory of its own.
const workspace = mkdtempSync(resolve(tmpdir(), "jarvis-todos-"));
process.env.JARVIS_CONFIG_DIR = workspace;
after(() => rmSync(workspace, { recursive: true, force: true }));

const { handleLocalActionRequest } = await import("../../desktop/actions/api");

const NOW = "2026-08-06T14:30";

function todo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: overrides.id ?? Math.random().toString(16).slice(2),
    title: "Aufgabe",
    category: "",
    important: false,
    due: "",
    steps: [],
    done: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    completedAt: "",
    calendarEventId: "",
    calendarLink: "",
    ...overrides,
  };
}

function post(path: string, body: unknown) {
  return handleLocalActionRequest(new Request(`http://127.0.0.1:4318/api/local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function json<T>(response: Promise<Response>) {
  return await (await response).json() as T;
}

test("a missed deadline is the only thing that becomes overdue", () => {
  const timed = todo({ due: "2026-08-06T14:00" });
  const later = todo({ due: "2026-08-06T18:00" });
  const wholeDay = todo({ due: "2026-08-06" });
  const yesterday = todo({ due: "2026-08-05" });
  const undated = todo();

  assert.equal(todoUrgency(timed, NOW), "overdue");
  assert.equal(todoUrgency(later, NOW), "today");
  // A task that names only a day stays due for that whole day and turns red the next morning.
  assert.equal(todoUrgency(wholeDay, NOW), "today");
  assert.equal(todoUrgency(yesterday, NOW), "overdue");
  // Without a date there is no deadline to miss, so it simply waits in the list.
  assert.equal(todoUrgency(undated, NOW), "someday");
  assert.equal(todoUrgency(todo({ due: "2026-08-05", done: true }), NOW), "done");
});

test("overdue sorts to the top and finished work leaves the open list", () => {
  const items = [
    todo({ id: "someday", title: "Irgendwann" }),
    todo({ id: "important-someday", title: "Wichtig ohne Datum", important: true }),
    todo({ id: "future", title: "Nächste Woche", due: "2026-08-20" }),
    todo({ id: "done", title: "Erledigt", due: "2026-08-01", done: true, completedAt: "2026-08-05T09:00:00.000Z" }),
    todo({ id: "today", title: "Heute", due: "2026-08-06T18:00" }),
    todo({ id: "overdue", title: "Steuererklärung", due: "2026-07-01" }),
  ];

  assert.deepEqual(orderTodos(items, NOW).map((entry) => entry.id), [
    "overdue",
    "today",
    "future",
    "important-someday",
    "someday",
    "done",
  ]);
  assert.deepEqual(todoCounts(items, NOW), { open: 5, overdue: 1, today: 1, done: 1 });
});

test("an important task never pushes a running deadline out of sight", () => {
  const items = [
    todo({ id: "tomorrow", title: "Morgen", due: "2026-08-07" }),
    todo({ id: "next-week", title: "Wichtig nächste Woche", due: "2026-08-20", important: true }),
  ];

  assert.deepEqual(orderTodos(items, NOW).map((entry) => entry.id), ["tomorrow", "next-week"]);
});

test("finds the task a spoken sentence means, and refuses the ones it does not", () => {
  const items = [
    todo({ id: "trip", title: "Urlaub planen", steps: [{ id: "flight", title: "Flug buchen", done: false }] }),
    todo({ id: "tax", title: "Steuererklärung abgeben" }),
  ];

  assert.equal(findTodo(items, "Urlaub")?.id, "trip");
  assert.equal(findTodo(items, "urlaub planen")?.id, "trip");
  assert.equal(findTodo(items, "die Steuer")?.id, "tax");
  assert.equal(findTodo(items, "Einkaufen gehen"), null);
  assert.equal(findTodo(items, ""), null);
  // A sub-task that describes the sentence better wins over its own parent.
  assert.equal(findTodoOrStep(items, "Flug buchen")?.step?.id, "flight");
  assert.equal(findTodoOrStep(items, "Urlaub")?.step, null);
  assert.ok(matchScore("Urlaub planen", "Urlaub planen") > matchScore("Urlaub planen", "Urlaub"));
});

test("an open task wins over a finished one with the same name", () => {
  const items = [
    todo({ id: "old", title: "Einkaufen", done: true }),
    todo({ id: "new", title: "Einkaufen" }),
  ];

  assert.equal(findTodo(items, "Einkaufen")?.id, "new");
});

test("deadlines are worded the way a person says them", () => {
  assert.equal(dueBadge("2026-08-06T15:00", NOW), "HEUTE 15:00");
  assert.equal(dueBadge("2026-08-07", NOW), "MORGEN");
  assert.equal(dueBadge("2026-08-10T09:30", NOW), "MO 09:30");
  assert.equal(dueBadge("2026-09-14", NOW), "14. SEP");
  assert.equal(dueBadge("", NOW), "");
  assert.equal(dueSentence("2026-08-06T15:00", NOW), "heute um 15:00 Uhr");
  assert.equal(dueSentence("2026-08-07", NOW), "morgen");
  assert.equal(dueSentence("2026-08-10", NOW), "am Montag");
  assert.equal(dueSentence("2026-09-14T08:00", NOW), "am 14. September um 08:00 Uhr");
});

test("the month grid starts on Monday and covers the surrounding weeks", () => {
  const grid = monthGrid(2026, 8);

  assert.equal(grid.length, 42);
  assert.equal(weekdayShort(grid[0]), "MO");
  // The 1st of August 2026 is a Saturday, so the grid opens with the tail of July.
  assert.equal(grid[0], "2026-07-27");
  assert.ok(grid.includes("2026-08-01"));
  assert.ok(grid.includes("2026-08-31"));
});

test("reminders fire before a time, in the morning for a whole day, and only once", () => {
  const timed = todo({ id: "timed", due: "2026-08-06T15:00" });
  const wholeDay = todo({ id: "day", due: "2026-08-06" });
  const undated = todo({ id: "undated" });

  assert.equal(reminderMoment(timed, 30), "2026-08-06T14:30");
  assert.equal(reminderMoment(wholeDay), "2026-08-06T09:00");
  assert.equal(reminderMoment(undated), "");
  assert.equal(shiftWallClock("2026-08-06T00:10", -30), "2026-08-05T23:40");

  const due = pendingReminders([timed, wholeDay, undated], NOW, new Set());
  assert.deepEqual(due.map((entry) => entry.id), ["day", "timed"]);
  // A reminder that was already sent stays sent, so the same deadline is not repeated.
  assert.deepEqual(pendingReminders([timed], NOW, new Set([reminderKey(timed)])), []);
  // A deadline from last month must not arrive as a notification at launch.
  assert.deepEqual(pendingReminders([todo({ due: "2026-07-01T09:00" })], NOW, new Set()), []);
});

test("the action layer keeps panel and voice on one list", async () => {
  const added = await json<{ todo: TodoItem; summary: string }>(post("/todos/add", {
    title: "Urlaub planen",
    category: "Urlaub",
    important: true,
  }));
  assert.match(added.summary, /„Urlaub planen“ steht jetzt als wichtig unter Urlaub auf deiner To-do-Liste\./u);
  assert.equal(added.todo.due, "");

  // The spoken name is enough; no id ever leaves the panel.
  const step = await json<{ todo: TodoItem }>(post("/todos/add-step", { query: "Urlaub", title: "Flug buchen" }));
  assert.deepEqual(step.todo.steps.map((entry) => entry.title), ["Flug buchen"]);

  const overdue = await json<{ todo: TodoItem }>(post("/todos/add", { title: "Steuer abgeben", due: "2020-01-15" }));
  assert.equal(overdue.todo.due, "2020-01-15");

  const list = await json<{ todos: TodoItem[]; counts: { open: number; overdue: number }; summary: string }>(
    post("/todos/list", { filter: "open" }),
  );
  assert.equal(list.counts.open, 2);
  assert.equal(list.counts.overdue, 1);
  // The missed deadline is spoken first, exactly as the panel shows it.
  assert.equal(list.todos[0].title, "Steuer abgeben");
  assert.match(list.summary, /überfällig/u);

  const checked = await json<{ summary: string; todo: TodoItem }>(post("/todos/complete", { query: "Flug buchen" }));
  assert.match(checked.summary, /Der Unterpunkt „Flug buchen“ bei „Urlaub planen“ ist abgehakt\./u);
  assert.equal(checked.todo.done, false);

  const parent = await json<{ todo: TodoItem }>(post("/todos/complete", { query: "Urlaub planen" }));
  assert.equal(parent.todo.done, true);
  assert.ok(parent.todo.steps.every((entry) => entry.done));

  const reopened = await json<{ todo: TodoItem }>(post("/todos/reopen", { query: "Urlaub planen" }));
  assert.equal(reopened.todo.done, false);
});

test("deleting a task needs an explicit confirmation, checking it off does not", async () => {
  await post("/todos/add", { title: "Rechnung bezahlen" });

  const unconfirmed = await post("/todos/remove", { query: "Rechnung bezahlen" });
  assert.equal(unconfirmed.status, 428);
  assert.equal((await unconfirmed.json() as { code: string }).code, "confirmation_required");
  for (const confirmed of ["true", 1, "ja", null]) {
    assert.equal((await post("/todos/remove", { query: "Rechnung", confirmed })).status, 428);
  }

  const removed = await json<{ summary: string }>(post("/todos/remove", { query: "Rechnung bezahlen", confirmed: true }));
  assert.match(removed.summary, /„Rechnung bezahlen“ ist gelöscht\./u);

  const missing = await post("/todos/complete", { query: "Rechnung bezahlen" });
  assert.equal(missing.status, 404);

  assert.equal((await post("/todos/clear-completed", {})).status, 428);
});

test("a deadline can be moved by voice and only disappears on purpose", async () => {
  await post("/todos/add", { title: "Reifen wechseln", due: "2027-03-14" });

  // The spoken name is enough here too, and the answer names the new deadline.
  const moved = await json<{ todo: TodoItem; summary: string }>(
    post("/todos/update", { query: "Reifen", due: "2027-04-20T15:00" }),
  );
  assert.equal(moved.todo.due, "2027-04-20T15:00");
  assert.match(moved.summary, /„Reifen wechseln“ ist jetzt fällig/u);

  // Moving only the day keeps the hour the task already had, instead of losing 15:00 silently.
  const sameHour = await json<{ todo: TodoItem }>(post("/todos/update", { query: "Reifen", due: "2027-04-21" }));
  assert.equal(sameHour.todo.due, "2027-04-21T15:00");

  // Spoken day words reach the same place a date does, and a named hour replaces the old one.
  const spoken = await json<{ todo: TodoItem }>(post("/todos/update", { query: "Reifen", due: "morgen um 9 Uhr" }));
  assert.match(spoken.todo.due, /^\d{4}-\d{2}-\d{2}T09:00$/u);

  // A date nobody can read is a mistake, not a removal, so the old deadline stays.
  const unreadable = await post("/todos/update", { query: "Reifen", due: "irgendwann mal" });
  assert.equal(unreadable.status, 400);
  const empty = await post("/todos/update", { query: "Reifen", due: "" });
  assert.equal(empty.status, 400);
  const list = await json<{ todos: TodoItem[] }>(post("/todos/list", { filter: "all" }));
  assert.equal(list.todos.find((entry) => entry.title === "Reifen wechseln")?.due, spoken.todo.due);

  // Only the explicit null clears it, and the task itself stays open.
  const cleared = await json<{ todo: TodoItem; summary: string }>(post("/todos/update", { query: "Reifen", due: null }));
  assert.equal(cleared.todo.due, "");
  assert.equal(cleared.todo.done, false);
  assert.match(cleared.summary, /„Reifen wechseln“ hat jetzt keine Frist mehr\./u);

  // With no hour left to keep, a bare day stays a whole day.
  const wholeDay = await json<{ todo: TodoItem }>(post("/todos/update", { query: "Reifen", due: "2027-05-02" }));
  assert.equal(wholeDay.todo.due, "2027-05-02");
});

test("a task without a date never lands in the calendar by accident", async () => {
  await post("/todos/add", { title: "Bücher sortieren" });

  const response = await post("/todos/calendar", { query: "Bücher sortieren", confirmed: true });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, "missing_due");
  // And without the confirmation it does not even get that far.
  assert.equal((await post("/todos/calendar", { query: "Bücher sortieren" })).status, 428);
});
