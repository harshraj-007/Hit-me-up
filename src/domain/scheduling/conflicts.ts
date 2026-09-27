import type { Task } from "@/domain/tasks";

export interface ScheduleConflict {
  firstTaskId: string;
  secondTaskId: string;
}

type ConflictTask = Pick<Task, "id" | "status" | "scheduledStart" | "scheduledEnd" | "unscheduled">;

/**
 * Pairs of unresolved, scheduled tasks whose half-open windows overlap. Windows that ended
 * before `now` are ignored: an overlap that is already over is history, not something the
 * user can act on. Unscheduled tasks hold no slot, so they never conflict. Output order is
 * deterministic (by start, then id).
 */
export function detectScheduleConflicts(
  tasks: readonly ConflictTask[],
  now: Date,
): ScheduleConflict[] {
  const live = tasks
    .filter(
      (t) => t.status === "upcoming" && !t.unscheduled && t.scheduledEnd.getTime() > now.getTime(),
    )
    .sort(
      (a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime() || a.id.localeCompare(b.id),
    );

  const conflicts: ScheduleConflict[] = [];
  for (let i = 0; i < live.length; i++) {
    const a = live[i]!;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j]!;
      if (b.scheduledStart.getTime() >= a.scheduledEnd.getTime()) break; // sorted: no later match
      conflicts.push({ firstTaskId: a.id, secondTaskId: b.id });
    }
  }
  return conflicts;
}
