import type { Task } from "./types";

export interface DayProgress {
  completed: number;
  skipped: number;
  total: number;
  /** Tasks that count toward progress: everything except skipped. */
  countable: number;
  /** completed / countable, or null when there is nothing countable (hide the ratio). */
  ratio: number | null;
}

/**
 * Progress is `completed / (total − skipped)`. A skipped task is a decision not to do
 * something, so it neither counts as done nor drags the ratio down; late and unscheduled
 * tasks are still unresolved and stay in the denominator.
 */
export function calculateDayProgress(tasks: readonly Pick<Task, "status">[]): DayProgress {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const skipped = tasks.filter((t) => t.status === "skipped").length;
  const total = tasks.length;
  const countable = total - skipped;
  return {
    completed,
    skipped,
    total,
    countable,
    ratio: countable > 0 ? completed / countable : null,
  };
}
