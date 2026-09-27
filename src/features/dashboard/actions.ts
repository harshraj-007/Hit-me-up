"use server";

import { runAction, type ActionResult } from "@/server/errors";
import {
  createTaskForDay,
  replanDay,
  rescheduleTaskForUser,
  updateTaskStatusForUser,
  type ReplanOutcome,
} from "@/server/services/tasks";
import { saveBriefingForToday } from "@/server/services/briefings";
import type { Task } from "@/domain/tasks";
import type { Briefing } from "@/server/db/repositories/briefings";

/** Thin wrappers: parse/validate happens in the service, persistence in the repository —
 *  these exist only to give the client component a serializable, non-throwing boundary. */

export async function createTaskAction(input: unknown): Promise<ActionResult<Task>> {
  return runAction(() => createTaskForDay(input));
}

export async function updateTaskStatusAction(input: unknown): Promise<ActionResult<Task>> {
  return runAction(() => updateTaskStatusForUser(input));
}

export async function rescheduleTaskAction(input: unknown): Promise<ActionResult<Task>> {
  return runAction(() => rescheduleTaskForUser(input));
}

/**
 * Optionally takes `{ planningDate }` — a calendar date only. The user, the day row, its
 * timezone and the clock are all resolved server-side; a client-supplied day id is never read.
 */
export async function replanRemainingDayAction(
  input?: unknown,
): Promise<ActionResult<ReplanOutcome>> {
  return runAction(() => replanDay(input));
}

export async function saveBriefingAction(input: unknown): Promise<ActionResult<Briefing>> {
  return runAction(() => saveBriefingForToday(input));
}
