"use client";

import { FormEvent, KeyboardEvent, PointerEvent, useMemo, useState } from "react";
import { dueBadge, dayTitle } from "@/features/todos/format";
import { dueDay, dueTime, orderTodos, stepProgress, todoUrgency } from "@/features/todos/ordering";
import type { TodoItem, TodoUrgency } from "@/features/todos/types";
import type { TodoController } from "../hooks/useTodos";

type TodoBoardProps = {
  visible: boolean;
  todos: TodoController;
  /** The day picked in the month, which filters the list and prefills a new task. */
  selectedDay: string;
  onSelectDay(day: string): void;
};

type Scope = "all" | "today" | "overdue";
/** The line the drop would leave the card on, drawn above or below the card under the pointer. */
type DropMark = { id: string; place: "before" | "after" };
/** The card in the hand and the group it came from, because a card is only dropped in its group. */
type Dragging = { id: string; urgency: TodoUrgency };

const GROUPS: Array<{ urgency: TodoUrgency; label: string }> = [
  { urgency: "overdue", label: "ÜBERFÄLLIG" },
  { urgency: "today", label: "HEUTE" },
  { urgency: "upcoming", label: "GEPLANT" },
  { urgency: "someday", label: "OHNE DATUM" },
];

/**
 * The two inputs of the compose row become the one due value the action layer stores. A time
 * without a day means today; a day without a time stays a whole day and never invents an hour.
 */
function composedDue(day: string, time: string, now: string) {
  const target = day || (time ? now.slice(0, 10) : "");
  if (!target) return "";
  return time ? `${target}T${time}` : target;
}

export function TodoBoard({ visible, todos, selectedDay, onSelectDay }: TodoBoardProps) {
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [category, setCategory] = useState("");
  const [important, setImportant] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [activeCategory, setActiveCategory] = useState("");
  const [openId, setOpenId] = useState("");
  const [stepDraft, setStepDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);
  const [editId, setEditId] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDay, setEditDay] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editCategory, setEditCategory] = useState("");

  const { counts, now, busyId } = todos;
  const composeDay = day || selectedDay;

  const scoped = useMemo(() => todos.todos.filter((todo) => {
    if (activeCategory && todo.category !== activeCategory) return false;
    if (selectedDay && todo.due.slice(0, 10) !== selectedDay) return false;
    if (scope === "all") return true;
    const urgency = todoUrgency(todo, now);
    if (scope === "overdue") return urgency === "overdue";
    return urgency === "today" || urgency === "overdue";
  }), [todos.todos, activeCategory, selectedDay, scope, now]);

  const visibleTodos = useMemo(() => orderTodos(scoped, now), [scoped, now]);

  const groups = GROUPS.map((group) => ({
    ...group,
    items: visibleTodos.filter((todo) => todoUrgency(todo, now) === group.urgency),
  })).filter((group) => group.items.length);
  const doneItems = visibleTodos.filter((todo) => todo.done);

  /**
   * A card is dropped among its own kind. Which group a task sits in is its deadline talking,
   * not a preference — a different group is a different date, and that is what editing is for.
   */
  const accepts = (target: TodoItem) => Boolean(dragging)
    && dragging?.id !== target.id
    && !target.done
    && todoUrgency(target, now) === dragging?.urgency;

  /**
   * The move runs on pointer events rather than on HTML5 drag and drop: the grip is a button, and
   * a button never starts a native drag in the WebView the app is packaged in.
   */
  const startDrag = (event: PointerEvent<HTMLButtonElement>, todo: TodoItem) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Without this the press would select the text of the card instead of taking it along.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging({ id: todo.id, urgency: todoUrgency(todo, now) });
    setDropMark(null);
  };

  /** The card under the pointer decides the mark: above its middle in front of it, below behind. */
  const trackDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-todo-id]");
    const target = card ? todos.todos.find((entry) => entry.id === card.dataset.todoId) : undefined;
    if (!card || !target || !accepts(target)) {
      setDropMark(null);
      return;
    }
    const box = card.getBoundingClientRect();
    const place: DropMark["place"] = event.clientY > box.top + box.height / 2 ? "after" : "before";
    setDropMark((current) => (current?.id === target.id && current.place === place ? current : { id: target.id, place }));
  };

  /** Let go over a card of the same group and the move counts; anywhere else it is called off. */
  const endDrag = () => {
    const moved = dragging?.id;
    const mark = dropMark;
    setDragging(null);
    setDropMark(null);
    if (moved && mark) void todos.reorder(moved, mark.id, mark.place);
  };

  /** The same move without a mouse: the grip walks the card through its group. */
  const moveByKey = (event: KeyboardEvent<HTMLButtonElement>, siblings: TodoItem[], index: number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const up = event.key === "ArrowUp";
    const neighbour = siblings[up ? index - 1 : index + 1];
    if (!neighbour) return;
    event.preventDefault();
    void todos.reorder(siblings[index].id, neighbour.id, up ? "before" : "after");
  };

  /** Editing starts from what the task says right now, split into the fields of the form. */
  const startEdit = (todo: TodoItem) => {
    setEditId(todo.id);
    setEditTitle(todo.title);
    setEditDay(dueDay(todo.due));
    setEditTime(dueTime(todo.due));
    setEditCategory(todo.category);
    setConfirmingId("");
  };

  const saveEdit = (event: FormEvent, todo: TodoItem) => {
    event.preventDefault();
    const text = editTitle.trim();
    if (!text) return;
    setEditId("");
    void todos.update(todo.id, {
      title: text,
      // An empty date field is a deadline the user dropped on purpose.
      due: composedDue(editDay, editTime, now) || null,
      exact: true,
      category: editCategory.trim(),
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    void todos.add({ title: text, due: composedDue(composeDay, time, now), category: category.trim(), important });
    setTitle("");
    setTime("");
    setImportant(false);
    // The category survives for the next task; an inherited deadline would only invent one.
    setDay("");
  };

  const submitStep = (event: FormEvent, todo: TodoItem) => {
    event.preventDefault();
    const text = stepDraft.trim();
    if (!text) return;
    void todos.addStep(todo.id, text);
    setStepDraft("");
  };

  /** `siblings` is the group the card is rendered in — the stretch it can be dragged along. */
  const renderTodo = (todo: TodoItem, siblings: TodoItem[] = []) => {
    const urgency = todoUrgency(todo, now);
    const progress = stepProgress(todo);
    const open = openId === todo.id;
    const busy = busyId === todo.id;
    const editing = editId === todo.id;
    const sortable = !todo.done && siblings.length > 1;
    const mark = dropMark?.id === todo.id && accepts(todo) ? dropMark.place : "";

    return (
      <article
        className={`todo-card ${todo.done ? "is-done" : ""} ${urgency === "overdue" ? "is-overdue" : ""} ${todo.important ? "is-important" : ""} ${sortable ? "is-sortable" : ""} ${dragging?.id === todo.id ? "is-dragging" : ""} ${mark ? `is-drop-${mark}` : ""}`}
        key={todo.id}
        data-todo-id={todo.id}
      >
        <div className="todo-line">
          {sortable ? (
            <button
              className="todo-grip"
              type="button"
              aria-label={`${todo.title} verschieben`}
              title="Ziehen — oder mit ↑ und ↓ verschieben"
              onPointerDown={(event) => startDrag(event, todo)}
              onPointerMove={trackDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={(event) => moveByKey(event, siblings, siblings.indexOf(todo))}
            >
              ⠿
            </button>
          ) : null}
          <button
            className="todo-check"
            type="button"
            aria-pressed={todo.done}
            aria-label={`${todo.title} ${todo.done ? "wieder öffnen" : "abhaken"}`}
            disabled={busy}
            onClick={() => void todos.toggle(todo)}
          >
            ✓
          </button>
          <div className="todo-body">
            <button
              className="todo-title"
              type="button"
              aria-expanded={open}
              onClick={() => {
                setOpenId(open ? "" : todo.id);
                setStepDraft("");
                setConfirmingId("");
                setEditId("");
              }}
            >
              {todo.title}
            </button>
            <div className="todo-meta">
              {todo.important ? <span className="todo-important-mark" title="Wichtig">★</span> : null}
              {todo.due ? (
                <span className={`todo-due ${urgency === "overdue" ? "is-overdue" : urgency === "today" ? "is-today" : ""}`}>
                  {urgency === "overdue" ? "ÜBERFÄLLIG · " : ""}{dueBadge(todo.due, now)}
                </span>
              ) : null}
              {todo.category ? <span className="todo-tag">{todo.category}</span> : null}
              {progress.total ? <span className="todo-step-count">{progress.done}/{progress.total}</span> : null}
              {todo.calendarEventId ? <span className="todo-step-count">KALENDER ✓</span> : null}
            </div>
          </div>
        </div>

        {open && editing ? (
          <form className="todo-detail todo-edit" onSubmit={(event) => saveEdit(event, todo)}>
            <input
              value={editTitle}
              aria-label="Aufgabe"
              maxLength={160}
              autoFocus
              onChange={(event) => setEditTitle(event.target.value)}
            />
            <div className="todo-edit-row">
              <input type="date" value={editDay} aria-label="Fällig am" onChange={(event) => setEditDay(event.target.value)} />
              <input type="time" value={editTime} aria-label="Uhrzeit" onChange={(event) => setEditTime(event.target.value)} />
              <input
                value={editCategory}
                placeholder="Kategorie"
                aria-label="Kategorie"
                maxLength={40}
                onChange={(event) => setEditCategory(event.target.value)}
              />
            </div>
            <div className="todo-actions">
              <button type="submit" className="is-active" disabled={busy || !editTitle.trim()}>SPEICHERN</button>
              <button type="button" onClick={() => setEditId("")}>ABBRECHEN</button>
              {editDay || editTime ? (
                <button type="button" onClick={() => { setEditDay(""); setEditTime(""); }}>FRIST ENTFERNEN</button>
              ) : null}
            </div>
          </form>
        ) : null}

        {open && !editing ? (
          <div className="todo-detail">
            {todo.steps.length ? (
              <ul className="todo-steps">
                {todo.steps.map((step) => (
                  <li className={step.done ? "is-done" : ""} key={step.id}>
                    <button
                      className="todo-check"
                      type="button"
                      aria-pressed={step.done}
                      aria-label={`${step.title} ${step.done ? "wieder öffnen" : "abhaken"}`}
                      disabled={busy}
                      onClick={() => void todos.toggleStep(todo.id, step.id, !step.done)}
                    >
                      ✓
                    </button>
                    <span>{step.title}</span>
                    <button
                      className="todo-step-remove"
                      type="button"
                      aria-label={`${step.title} entfernen`}
                      disabled={busy}
                      onClick={() => void todos.removeStep(todo.id, step.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <form className="todo-step-form" onSubmit={(event) => submitStep(event, todo)}>
              <input
                value={stepDraft}
                placeholder="Unterpunkt hinzufügen …"
                aria-label={`Unterpunkt für ${todo.title}`}
                onChange={(event) => setStepDraft(event.target.value)}
              />
              <button type="submit" disabled={busy || !stepDraft.trim()} aria-label="Unterpunkt speichern">+</button>
            </form>

            <div className="todo-actions">
              <button type="button" disabled={busy} onClick={() => startEdit(todo)}>BEARBEITEN</button>
              <button
                type="button"
                className={todo.important ? "is-active" : ""}
                disabled={busy}
                onClick={() => void todos.update(todo.id, { important: !todo.important })}
              >
                {todo.important ? "WICHTIG ✓" : "WICHTIG"}
              </button>
              <button
                type="button"
                className={todo.calendarEventId ? "is-active" : ""}
                disabled={busy || !todo.due || Boolean(todo.calendarEventId)}
                title={todo.due ? undefined : "Diese Aufgabe hat kein Datum"}
                onClick={() => void todos.toCalendar(todo.id)}
              >
                {todo.calendarEventId ? "IM KALENDER ✓" : "IN KALENDER"}
              </button>
              <button
                type="button"
                className={`is-danger ${confirmingId === todo.id ? "is-confirming" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (confirmingId !== todo.id) {
                    setConfirmingId(todo.id);
                    return;
                  }
                  setConfirmingId("");
                  void todos.remove(todo.id);
                }}
              >
                {confirmingId === todo.id ? "WIRKLICH LÖSCHEN?" : "LÖSCHEN"}
              </button>
            </div>
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <aside className={`todo-panel ${visible ? "is-visible" : ""}`} aria-label="To-do-Liste">
      <header className="todo-header">
        <div>
          <span className="eyebrow">TO-DO</span>
          <h2>{counts.open} {counts.open === 1 ? "Aufgabe" : "Aufgaben"}</h2>
        </div>
        <span className={`todo-counter ${counts.overdue ? "is-alert" : ""}`}>
          {counts.overdue ? `${counts.overdue} ÜBERFÄLLIG` : `${counts.today} HEUTE`}
          <br />
          {counts.done} ERLEDIGT
        </span>
      </header>

      <form className="todo-compose" onSubmit={submit}>
        <div className="todo-compose-line">
          <input
            value={title}
            placeholder="Neue Aufgabe …"
            aria-label="Neue Aufgabe"
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="todo-add" type="submit" disabled={!title.trim() || busyId === "new"} aria-label="Aufgabe hinzufügen">
            +
          </button>
        </div>
        <div className="todo-compose-row">
          <input
            type="date"
            value={composeDay}
            aria-label="Fällig am"
            onChange={(event) => {
              setDay(event.target.value);
              if (selectedDay) onSelectDay("");
            }}
          />
          <input type="time" value={time} aria-label="Uhrzeit" onChange={(event) => setTime(event.target.value)} />
          <input
            value={category}
            placeholder="Kategorie"
            aria-label="Kategorie"
            maxLength={40}
            onChange={(event) => setCategory(event.target.value)}
          />
          <button
            type="button"
            className={`todo-flag ${important ? "is-active" : ""}`}
            aria-pressed={important}
            aria-label="Als wichtig markieren"
            onClick={() => setImportant((current) => !current)}
          >
            ★
          </button>
        </div>
      </form>

      <div className="todo-filters">
        <button type="button" className={scope === "all" && !selectedDay ? "is-active" : ""} onClick={() => { setScope("all"); onSelectDay(""); }}>
          ALLE
        </button>
        <button type="button" className={scope === "today" ? "is-active" : ""} onClick={() => setScope("today")}>HEUTE</button>
        <button
          type="button"
          className={`is-alert ${scope === "overdue" ? "is-active" : ""}`}
          onClick={() => setScope("overdue")}
        >
          ÜBERFÄLLIG {counts.overdue ? `· ${counts.overdue}` : ""}
        </button>
        {todos.categories.map((entry) => (
          <button
            key={entry}
            type="button"
            className={activeCategory === entry ? "is-active" : ""}
            onClick={() => setActiveCategory(activeCategory === entry ? "" : entry)}
          >
            {entry.toUpperCase()}
          </button>
        ))}
        {selectedDay ? (
          <button type="button" className="is-active" onClick={() => onSelectDay("")}>
            {dayTitle(selectedDay).toUpperCase()} ×
          </button>
        ) : null}
      </div>

      {todos.error ? (
        <p className="todo-error" role="alert">
          <span>{todos.error}</span>
          <button type="button" onClick={todos.clearError} aria-label="Meldung schließen">×</button>
        </p>
      ) : null}

      <div className="todo-list">
        {!todos.available ? (
          <div className="todo-notice">
            <p>Die To-do-Liste lebt auf diesem Mac und ist nur in der lokalen JARVIS-App verfügbar.</p>
          </div>
        ) : null}

        {todos.available && !todos.loading && !visibleTodos.length ? (
          <div className="todo-empty">
            <strong>Nichts offen.</strong>
            <p>Sag „Jarvis, füg zu meiner To-do-Liste hinzu, dass ich einen Urlaub planen muss“ — oder tippe es oben ein.</p>
          </div>
        ) : null}

        {groups.map((group) => (
          <section className="todo-group" key={group.urgency} aria-label={group.label}>
            <span className={`todo-group-label ${group.urgency === "overdue" ? "is-alert" : ""}`}>
              {group.label} <b>{group.items.length}</b>
            </span>
            {group.items.map((item) => renderTodo(item, group.items))}
          </section>
        ))}

        {doneItems.length ? (
          <section className="todo-group" aria-label="Erledigt">
            <button className="todo-group-label" type="button" aria-expanded={showDone} onClick={() => setShowDone((current) => !current)}>
              ERLEDIGT <b>{showDone ? "▾" : "▸"} {doneItems.length}</b>
            </button>
            {showDone ? doneItems.map((item) => renderTodo(item)) : null}
            {showDone ? (
              <div className="todo-actions">
                <button
                  type="button"
                  className={`is-danger ${confirmingId === "completed" ? "is-confirming" : ""}`}
                  disabled={busyId === "completed"}
                  onClick={() => {
                    if (confirmingId !== "completed") {
                      setConfirmingId("completed");
                      return;
                    }
                    setConfirmingId("");
                    void todos.clearCompleted();
                  }}
                >
                  {confirmingId === "completed" ? "WIRKLICH AUFRÄUMEN?" : "ERLEDIGTE AUFRÄUMEN"}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
