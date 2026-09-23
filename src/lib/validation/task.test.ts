import { describe, expect, it } from "vitest";
import { createTaskInputSchema, updateTaskStatusInputSchema } from "./task";

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
