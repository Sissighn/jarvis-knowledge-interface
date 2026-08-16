/**
 * Finding the to-do a spoken sentence means. Nobody repeats a title word for word: "hak den
 * Urlaub ab" has to reach "Urlaub planen", while "Steuererklärung" must not silently check off
 * the wrong entry. Matching is therefore scored and refuses anything below the threshold.
 */
import type { TodoItem, TodoStep } from "./types";

/** Words that carry no meaning in a spoken reference and would only inflate the score. */
const FILLER = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "mein", "meine", "meinen", "meiner", "meinem", "zu", "zum", "zur", "auf", "an", "am",
  "in", "im", "und", "von", "vom", "für", "fuer", "mit", "aus", "bei", "als", "ist",
  "todo", "aufgabe", "punkt", "eintrag", "liste",
]);

const MATCH_THRESHOLD = 0.5;

export function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/ä/gu, "ae")
    .replace(/ö/gu, "oe")
    .replace(/ü/gu, "ue")
    .replace(/ß/gu, "ss")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function titleTokens(value: string) {
  return normalizeTitle(value)
    .split(" ")
    .filter((token) => token.length > 2 && !FILLER.has(token));
}

/**
 * How well a spoken reference describes a title, between 0 and 1. A partial word still counts,
 * because "Steuer" is how people refer to "Steuererklärung".
 */
export function matchScore(title: string, query: string) {
  const candidate = normalizeTitle(title);
  const wanted = normalizeTitle(query);
  if (!candidate || !wanted) return 0;
  if (candidate === wanted) return 1;
  if (candidate.includes(wanted) || wanted.includes(candidate)) return 0.9;

  const queryTokens = titleTokens(query);
  if (!queryTokens.length) return 0;
  const titleWords = titleTokens(title);
  if (!titleWords.length) return 0;

  const hits = queryTokens.filter((token) => titleWords.some((word) => (
    word === token || word.startsWith(token) || token.startsWith(word)
  )));
  return (hits.length / queryTokens.length) * 0.8;
}

/**
 * The to-do a sentence refers to, or null when nothing matches well enough. Open work wins over
 * finished work at the same score, so "hak den Urlaub ab" never lands on last month's entry.
 */
export function findTodo(todos: TodoItem[], query: string): TodoItem | null {
  let best: { todo: TodoItem; score: number } | null = null;
  for (const todo of todos) {
    const score = matchScore(todo.title, query);
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score || (score === best.score && best.todo.done && !todo.done)) {
      best = { todo, score };
    }
  }
  return best?.todo ?? null;
}

export function findStep(steps: TodoStep[], query: string): TodoStep | null {
  let best: { step: TodoStep; score: number } | null = null;
  for (const step of steps) {
    const score = matchScore(step.title, query);
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score || (score === best.score && best.step.done && !step.done)) {
      best = { step, score };
    }
  }
  return best?.step ?? null;
}

/**
 * The to-do a spoken sentence means, searched in the steps as well. A sub-task that matches
 * better than every title is returned with its parent, so "hak Flug buchen ab" ticks the step.
 */
export function findTodoOrStep(todos: TodoItem[], query: string) {
  const todo = findTodo(todos, query);
  const titleScore = todo ? matchScore(todo.title, query) : 0;

  let bestStep: { todo: TodoItem; step: TodoStep; score: number } | null = null;
  for (const candidate of todos) {
    for (const step of candidate.steps) {
      const score = matchScore(step.title, query);
      if (score < MATCH_THRESHOLD) continue;
      if (!bestStep || score > bestStep.score || (score === bestStep.score && bestStep.step.done && !step.done)) {
        bestStep = { todo: candidate, step, score };
      }
    }
  }

  if (bestStep && bestStep.score > titleScore) return { todo: bestStep.todo, step: bestStep.step };
  return todo ? { todo, step: null } : null;
}
