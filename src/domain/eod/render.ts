import type { EodTaskFact } from "./types";

/** `[t3]` — how a model may name a task inside prose. Nothing else in square brackets is allowed. */
export const REF_PLACEHOLDER = /\[(t[1-9]\d{0,3})\]/g;

/**
 * Replaces each `[tN]` with that task's own title (from the stored facts). The model never writes
 * a title: it can only point at a task, and what is shown is what the user themselves typed. A
 * placeholder with no matching task renders as a neutral word rather than leaking the alias.
 */
export function renderRefs(text: string, tasks: readonly EodTaskFact[]): string {
  const byRef = new Map(tasks.map((t) => [t.ref, t.title]));
  return text.replace(REF_PLACEHOLDER, (_m, ref: string) => byRef.get(ref) ?? "a task");
}
