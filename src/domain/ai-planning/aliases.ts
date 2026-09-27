import type { Task } from "@/domain/tasks";

/** Shape of an AI-facing task reference: `t1`, `t2`, … A UUID never matches. */
export const ALIAS_PATTERN = /^t[1-9]\d{0,3}$/;

export function isAliasShaped(value: unknown): value is string {
  return typeof value === "string" && ALIAS_PATTERN.test(value);
}

export interface AliasAssignment {
  /** Tasks in alias order (`ordered[0]` is `t1`). */
  ordered: readonly Task[];
  /** alias → real task id. SERVER-SIDE ONLY; never sent to a provider. */
  refToTaskId: ReadonlyMap<string, string>;
  taskIdToRef: ReadonlyMap<string, string>;
}

/**
 * Deterministic aliases for one planning context. Order is by scheduled start, then creation
 * time, then id — so it does not depend on the order the database returned rows in, and the
 * same tasks always get the same aliases. The mapping is valid only for the context/proposal it
 * was built for; only tasks passed in (the caller's own, read under RLS) can ever be named.
 */
export function assignAliases(tasks: readonly Task[]): AliasAssignment {
  const ordered = [...tasks].sort(
    (a, b) =>
      a.scheduledStart.getTime() - b.scheduledStart.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const refToTaskId = new Map<string, string>();
  const taskIdToRef = new Map<string, string>();
  ordered.forEach((task, index) => {
    const ref = `t${index + 1}`;
    refToTaskId.set(ref, task.id);
    taskIdToRef.set(task.id, ref);
  });
  return { ordered, refToTaskId, taskIdToRef };
}
