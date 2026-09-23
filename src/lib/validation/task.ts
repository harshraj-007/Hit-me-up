import { z } from "zod";

export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_NOTES_MAX_LENGTH = 2000;

const taskPrioritySchema = z.enum(["high", "medium", "low"]);
const taskKindSchema = z.enum(["fixed", "flexible", "deadline", "optional", "recurring"]);
const taskStatusSchema = z.enum(["upcoming", "completed", "skipped", "late"]);

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
  })
  .refine((input) => input.scheduledEnd > input.scheduledStart, {
    message: "End time must be after the start time.",
    path: ["scheduledEnd"],
  });

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

/** Input for a status-changing action (Complete / Skip / Mark late). */
export const updateTaskStatusInputSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(["completed", "skipped", "late"]),
});

export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusInputSchema>;

export { taskPrioritySchema, taskKindSchema, taskStatusSchema };
