/**
 * The Web Push payload for a `task_reminder` notification — pure, deterministic, no AI
 * involvement of any kind (an explicit product decision: notification copy is fixed and
 * server-generated, never AI-authored). Kept separate from the delivery service so it can be
 * unit-tested without a database or the `web-push` library at all.
 *
 * The payload is untrusted data from the future service worker's point of view (Phase 6.4) —
 * it must never need to be authoritative about scheduling, and it deliberately carries only
 * what a reminder notification needs to display and deep-link, nothing about who the user is,
 * how they're identified, or anything from another subsystem (AI, auth, subscriptions).
 */

/** Fixed, not derived from the task — matches the product's chosen notification title exactly. */
export const TASK_REMINDER_TITLE = "Task reminder";

/** The task title portion of the body is truncated to this many characters before the fixed
 *  " starts in 10 minutes" suffix is appended, keeping the whole payload comfortably under 1KB
 *  (Web Push's own limit is 4KB) regardless of a task's title length (titles are capped at 200
 *  characters elsewhere, but the notification body has no reason to ever be that long). */
export const TASK_TITLE_SNIPPET_MAX_LENGTH = 90;

export interface TaskReminderPayloadInput {
  notificationId: string;
  taskId: string;
  taskTitle: string;
  /** The task's scheduled_start this reminder was generated for (the persisted snapshot, not a
   *  live re-read — matches what the notification actually fired for). */
  scheduledStart: Date;
}

export interface TaskReminderPayload {
  type: "task_reminder";
  notificationId: string;
  taskId: string;
  title: string;
  body: string;
  scheduledStart: string;
  url: string;
}

/** Deterministic truncation: never mid-surrogate-pair-unsafe (works on `string` code units,
 *  same as the rest of this codebase's length limits), always the same output for the same
 *  input — no randomness, no locale dependence. */
function truncateTitleSnippet(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= TASK_TITLE_SNIPPET_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, TASK_TITLE_SNIPPET_MAX_LENGTH - 1).trimEnd() + "…";
}

/**
 * Builds the exact payload sent to every active subscription for a claimed `task_reminder`
 * notification. Never reads or accepts a task's `notes`, the notification's `user_id`, any
 * subscription credential, or anything from AI/auth/CRON_SECRET/service-role config — there is
 * no field on `TaskReminderPayloadInput` for any of them, so none can leak here even by
 * accident; this is enforced by the type, not by a rule someone has to remember. `url` is
 * deliberately the plain dashboard route, not a per-task deep link (e.g. by date) — the
 * smallest useful destination for Phase 6.4's future service worker to open.
 */
export function buildTaskReminderPayload(input: TaskReminderPayloadInput): TaskReminderPayload {
  const snippet = truncateTitleSnippet(input.taskTitle);
  return {
    type: "task_reminder",
    notificationId: input.notificationId,
    taskId: input.taskId,
    title: TASK_REMINDER_TITLE,
    body: `${snippet} starts in 10 minutes`,
    scheduledStart: input.scheduledStart.toISOString(),
    url: "/today",
  };
}
