import { deriveTaskTemporalState, isResolved, type Task } from "@/domain/tasks";

/**
 * Proposal-time eligibility: may an AI PROPOSAL name this task for a move or an unschedule?
 *
 * This is deliberately NOT `isAutoMovable`. That rule belongs to the deterministic planner and
 * its persistence path (`apply_replan`), which only ever touches planner-created tasks, and it
 * is unchanged. A proposal is not applied here — it is validated, shown, and only persisted
 * after explicit user confirmation through a dedicated future path — so who created the task
 * (`source`) is not part of this rule: a user-created task can be proposed, exactly like a
 * planner one. Everything else that protects a task still holds:
 *
 *  - it belongs to the planning day being planned (another day's task, e.g. spillover, is an
 *    obstacle, never a candidate);
 *  - it is unresolved (completed / skipped are terminal);
 *  - it is not locked by a manual move (no override in v1);
 *  - it is not `fixed`;
 *  - it is not in progress right now.
 *
 * Being eligible to be PROPOSED says nothing about being applicable: the validator still runs
 * the full window/duration/conflict rules, and persistence re-checks everything in SQL.
 */
export function isAiMovable(task: Task, now: Date, dayId: string): boolean {
  return (
    task.dayId === dayId &&
    !isResolved(task.status) &&
    !task.scheduleLocked &&
    task.kind !== "fixed" &&
    deriveTaskTemporalState(task, now) !== "current"
  );
}
