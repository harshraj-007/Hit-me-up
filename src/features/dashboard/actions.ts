"use server";

import { runAction, type ActionResult } from "@/server/errors";
import { createTaskForToday, updateTaskStatusForUser } from "@/server/services/tasks";
import { saveBriefingForToday } from "@/server/services/briefings";
import type { Task } from "@/domain/tasks";
import type { Briefing } from "@/server/db/repositories/briefings";

/** Thin wrappers: parse/validate happens in the service, persistence in the repository —
 *  these exist only to give the client component a serializable, non-throwing boundary. */

export async function createTaskAction(input: unknown): Promise<ActionResult<Task>> {
  return runAction(() => createTaskForToday(input));
}

export async function updateTaskStatusAction(input: unknown): Promise<ActionResult<Task>> {
  return runAction(() => updateTaskStatusForUser(input));
}

export async function saveBriefingAction(input: unknown): Promise<ActionResult<Briefing>> {
  return runAction(() => saveBriefingForToday(input));
}
