import { describe, expect, it } from "vitest";
import {
  createTaskInputSchema,
  rescheduleTaskInputSchema,
  updateTaskStatusInputSchema,
} from "./task";

describe("createTaskInputSchema", () => {
  it("accepts a minimal valid task", () => {
    const result = createTaskInputSchema.safeParse({
      title: "Write the report",
      scheduledStart: new Date("2026-09-22T09:00:00Z"),
      scheduledEnd: new Date("2026-09-22T09:30:00Z"),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe("medium");
      expect(result.data.kind).toBe("flexible");
    }
  });

  it("rejects a blank title", () => {
    expect(
      createTaskInputSchema.safeParse({
        title: "   ",
        scheduledStart: new Date(),
        scheduledEnd: new Date(Date.now() + 60_000),
      }).success,
    ).toBe(false);
  });

  it("rejects a title over the max length", () => {
    expect(
      createTaskInputSchema.safeParse({
        title: "x".repeat(201),
        scheduledStart: new Date(),
        scheduledEnd: new Date(Date.now() + 60_000),
      }).success,
    ).toBe(false);
  });

  it("rejects an end time at or before the start time", () => {
    const start = new Date("2026-09-22T09:00:00Z");
    expect(
      createTaskInputSchema.safeParse({ title: "x", scheduledStart: start, scheduledEnd: start })
        .success,
    ).toBe(false);
    expect(
      createTaskInputSchema.safeParse({
        title: "x",
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() - 1000),
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid priority/kind", () => {
    expect(
      createTaskInputSchema.safeParse({
        title: "x",
        priority: "urgent",
        scheduledStart: new Date(),
        scheduledEnd: new Date(Date.now() + 1000),
      }).success,
    ).toBe(false);
  });
});

describe("updateTaskStatusInputSchema", () => {
  it("accepts a valid uuid and status", () => {
    expect(
      updateTaskStatusInputSchema.safeParse({
        taskId: "11111111-1111-4111-8111-111111111111",
        status: "completed",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid taskId", () => {
    expect(
      updateTaskStatusInputSchema.safeParse({ taskId: "not-a-uuid", status: "completed" }).success,
    ).toBe(false);
  });

  it("rejects a status outside the mutable set (e.g. 'upcoming' or 'current')", () => {
    expect(
      updateTaskStatusInputSchema.safeParse({
        taskId: "11111111-1111-4111-8111-111111111111",
        status: "upcoming",
      }).success,
    ).toBe(false);
    expect(
      updateTaskStatusInputSchema.safeParse({
        taskId: "11111111-1111-4111-8111-111111111111",
        status: "current",
      }).success,
    ).toBe(false);
  });
});

describe("createTaskInputSchema — planning day and duration (Phase 4.1)", () => {
  const base = {
    title: "x",
    scheduledStart: new Date("2026-09-24T23:30:00Z"),
  };
  const withMinutes = (m: number) => ({
    ...base,
    scheduledEnd: new Date(base.scheduledStart.getTime() + m * 60_000),
  });

  it("accepts an optional planningDate as a plain calendar date", () => {
    expect(
      createTaskInputSchema.safeParse({ ...withMinutes(30), planningDate: "2026-09-25" }).success,
    ).toBe(true);
    expect(createTaskInputSchema.safeParse(withMinutes(30)).success).toBe(true);
  });

  it.each(["2026-9-25", "tomorrow", "2026-02-30", "2026-09-25T00:00:00Z", ""])(
    "rejects a malformed planningDate %j",
    (planningDate) => {
      expect(createTaskInputSchema.safeParse({ ...withMinutes(30), planningDate }).success).toBe(
        false,
      );
    },
  );

  it("enforces 5 to 1440 minutes, inclusive", () => {
    expect(createTaskInputSchema.safeParse(withMinutes(4)).success).toBe(false);
    expect(createTaskInputSchema.safeParse(withMinutes(5)).success).toBe(true);
    expect(createTaskInputSchema.safeParse(withMinutes(1440)).success).toBe(true);
    expect(createTaskInputSchema.safeParse(withMinutes(1441)).success).toBe(false);
  });

  it("does not accept a day id, and strips it rather than trusting it", () => {
    const parsed = createTaskInputSchema.safeParse({
      ...withMinutes(30),
      dayId: "11111111-1111-4111-8111-111111111111",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty("dayId");
  });
});

describe("rescheduleTaskInputSchema — the task and its new START only", () => {
  const taskId = "11111111-1111-4111-8111-111111111111";

  it("accepts a task id and a start", () => {
    expect(
      rescheduleTaskInputSchema.safeParse({ taskId, scheduledStart: "2026-09-24T18:00:00Z" })
        .success,
    ).toBe(true);
  });

  it.each([
    ["scheduledEnd", { scheduledEnd: "2026-09-24T19:00:00Z" }],
    ["durationMinutes", { durationMinutes: 90 }],
    ["dayId", { dayId: "victim" }],
    ["userId", { userId: "victim" }],
  ])("refuses an extra %s with a message that says why", (_key, extra) => {
    const result = rescheduleTaskInputSchema.safeParse({
      taskId,
      scheduledStart: new Date(),
      ...extra,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toMatch(/keeps the task's duration/);
  });

  it("requires a valid uuid and a valid date", () => {
    expect(
      rescheduleTaskInputSchema.safeParse({ taskId: "nope", scheduledStart: new Date() }).success,
    ).toBe(false);
    expect(
      rescheduleTaskInputSchema.safeParse({ taskId, scheduledStart: "not a date" }).success,
    ).toBe(false);
    expect(rescheduleTaskInputSchema.safeParse({ taskId }).success).toBe(false);
  });
});
