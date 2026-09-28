import { describe, expect, it } from "vitest";
import {
  buildTaskReminderPayload,
  TASK_REMINDER_TITLE,
  TASK_TITLE_SNIPPET_MAX_LENGTH,
  type TaskReminderPayloadInput,
} from "./task-reminder-payload";

const BASE: TaskReminderPayloadInput = {
  notificationId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  taskTitle: "DSA practice",
  scheduledStart: new Date("2026-09-30T10:00:00.000Z"),
};

describe("buildTaskReminderPayload", () => {
  it("is fully deterministic — same input, same output, every time", () => {
    expect(buildTaskReminderPayload(BASE)).toEqual(buildTaskReminderPayload(BASE));
  });

  it("produces the documented shape", () => {
    expect(buildTaskReminderPayload(BASE)).toEqual({
      type: "task_reminder",
      notificationId: BASE.notificationId,
      taskId: BASE.taskId,
      title: "Task reminder",
      body: "DSA practice starts in 10 minutes",
      scheduledStart: "2026-09-30T10:00:00.000Z",
      url: "/today",
    });
  });

  it("uses the fixed title, never derived from the task", () => {
    expect(buildTaskReminderPayload(BASE).title).toBe(TASK_REMINDER_TITLE);
    expect(buildTaskReminderPayload({ ...BASE, taskTitle: "Something else" }).title).toBe(
      TASK_REMINDER_TITLE,
    );
  });

  it("includes the task title as the primary context in the body", () => {
    expect(buildTaskReminderPayload({ ...BASE, taskTitle: "Write the report" }).body).toBe(
      "Write the report starts in 10 minutes",
    );
  });

  it("never includes task notes — there is no field for them at all", () => {
    const input = BASE as unknown as Record<string, unknown>;
    expect(input.notes).toBeUndefined();
    expect(input.taskNotes).toBeUndefined();
    expect(Object.keys(buildTaskReminderPayload(BASE))).not.toContain("notes");
  });

  it("never includes a user id, auth token, subscription credential, or internal secret — there is no field for any of them", () => {
    const payload = buildTaskReminderPayload(BASE) as unknown as Record<string, unknown>;
    for (const forbidden of [
      "userId",
      "user_id",
      "email",
      "endpoint",
      "p256dh",
      "authKey",
      "auth_key",
      "cronSecret",
      "CRON_SECRET",
      "serviceRoleKey",
      "vapidPrivateKey",
      "VAPID_PRIVATE_KEY",
      "revisionId",
    ]) {
      expect(payload[forbidden]).toBeUndefined();
    }
  });

  it("truncates a long task title deterministically, with an ellipsis, and stays within the chosen bound", () => {
    const longTitle = "x".repeat(200);
    const payload = buildTaskReminderPayload({ ...BASE, taskTitle: longTitle });
    expect(payload.body.length).toBeLessThan(longTitle.length);
    expect(payload.body).toContain("…");
    expect(payload.body.startsWith("x".repeat(TASK_TITLE_SNIPPET_MAX_LENGTH - 1))).toBe(true);
    expect(payload.body.endsWith("starts in 10 minutes")).toBe(true);
  });

  it("does not truncate a title within the bound", () => {
    const title = "x".repeat(TASK_TITLE_SNIPPET_MAX_LENGTH);
    const payload = buildTaskReminderPayload({ ...BASE, taskTitle: title });
    expect(payload.body).toBe(`${title} starts in 10 minutes`);
    expect(payload.body).not.toContain("…");
  });

  it("trims surrounding whitespace from the title before measuring/truncating", () => {
    expect(buildTaskReminderPayload({ ...BASE, taskTitle: "  Write the report  " }).body).toBe(
      "Write the report starts in 10 minutes",
    );
  });

  it("serializes to valid JSON", () => {
    const payload = buildTaskReminderPayload(BASE);
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("stays well under Web Push's 4KB limit even with the longest possible title", () => {
    const payload = buildTaskReminderPayload({ ...BASE, taskTitle: "x".repeat(200) });
    const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(size).toBeLessThan(1024);
  });

  it("formats scheduledStart as an ISO string", () => {
    expect(buildTaskReminderPayload(BASE).scheduledStart).toBe("2026-09-30T10:00:00.000Z");
  });

  it("always points url at the plain dashboard route", () => {
    expect(buildTaskReminderPayload(BASE).url).toBe("/today");
  });
});
