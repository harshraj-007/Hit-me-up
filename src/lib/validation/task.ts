import { z } from "zod";
import { MAX_TASK_DURATION_MINUTES, MIN_TASK_DURATION_MINUTES } from "@/domain/days/planning-day";
import { localDateSchema } from "./day";

export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_NOTES_MAX_LENGTH = 2000;

const taskPrioritySchema = z.enum(["high", "medium", "low"]);
const taskKindSchema = z.enum(["fixed", "flexible", "deadline", "optional", "recurring"]);
const taskStatusSchema = z.enum(["upcoming", "completed", "skipped"]);

/** Input for creating a task through the Add Task dialog (always source: "user"). */
export const createTaskInputSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required.").max(TASK_TITLE_MAX_LENGTH),
    notes: z.string().trim().max(TASK_NOTES_MAX_LENGTH).optional(),
    priority: taskPrioritySchema.default("medium"),
    kind: taskKindSchema.default("flexible"),
    scheduledStart: z.coerce.date(),
    scheduledEnd: z.coerce.date(),
    dueAt: z.coerce.date().optional(),
    /**
     * Which local calendar day to plan for (`YYYY-MM-DD`); omitted means today. It only ever
     * names a DATE — the server resolves the actual day row from the caller's session, so a
     * client can never supply (or spoof) a day id. The horizon check needs "today" in the
     * user's timezone, so it lives in the service, not here.
     */
    planningDate: localDateSchema.optional(),
  })
  .refine((input) => input.scheduledEnd > input.scheduledStart, {
    message: "End time must be after the start time.",
    path: ["scheduledEnd"],
  })
  .refine(
    (input) => {
      const minutes = (input.scheduledEnd.getTime() - input.scheduledStart.getTime()) / 60_000;
      return minutes >= MIN_TASK_DURATION_MINUTES && minutes <= MAX_TASK_DURATION_MINUTES;
    },
    {
      message: `A task must last between ${MIN_TASK_DURATION_MINUTES} minutes and 24 hours.`,
      path: ["scheduledEnd"],
    },
  );

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

/** Input for a status-changing action (Complete / Skip). "Late" is derived, never set. */
export const updateTaskStatusInputSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(["completed", "skipped"]),
});

export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusInputSchema>;

/**
 * Input for moving a task by hand: the task id and the NEW START only. The end is derived on the
 * server from the task's stored duration (rescheduling never resizes a task), so an `end`, a
 * duration, or anything else is refused outright rather than silently ignored — that includes
 * client-supplied owner or day ids, which have no authority here.
 */
export const rescheduleTaskInputSchema = z.strictObject(
  {
    taskId: z.uuid(),
    scheduledStart: z.coerce.date(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? "Rescheduling keeps the task's duration: send only the task and its new start time."
        : undefined,
  },
);

export type RescheduleTaskInput = z.infer<typeof rescheduleTaskInputSchema>;

export { taskPrioritySchema, taskKindSchema, taskStatusSchema };
