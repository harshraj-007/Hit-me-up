import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/server/errors";
import { changeTaskStatus, listTasksForDay } from "./tasks";

function fakeSupabase(rpcResult: { data: unknown; error: unknown }) {
  return { rpc: vi.fn(async () => rpcResult) } as never;
}

describe("changeTaskStatus", () => {
  it("maps the RPC's P0002 (no_data_found) error to NotFoundError", async () => {
    const supabase = fakeSupabase({ data: null, error: { code: "P0002", message: "not found" } });
    await expect(changeTaskStatus(supabase, "task-1", "completed")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("maps any other database error to an ExternalServiceError, not NotFoundError", async () => {
    const supabase = fakeSupabase({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    await expect(changeTaskStatus(supabase, "task-1", "completed")).rejects.not.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("maps a successful RPC row back to the domain Task shape", async () => {
    const row = {
      id: "task-1",
      user_id: "user-1",
      day_id: "day-1",
      title: "Write the report",
      notes: null,
      status: "completed",
      priority: "medium",
      kind: "flexible",
      source: "user",
      scheduled_start: "2026-09-22T09:00:00.000Z",
      scheduled_end: "2026-09-22T09:30:00.000Z",
      due_at: null,
      completed_at: "2026-09-22T09:10:00.000Z",
      created_at: "2026-09-22T08:00:00.000Z",
      updated_at: "2026-09-22T09:10:00.000Z",
    };
    const supabase = fakeSupabase({ data: row, error: null });
    const task = await changeTaskStatus(supabase, "task-1", "completed");
    expect(task.status).toBe("completed");
    expect(task.completedAt).toEqual(new Date("2026-09-22T09:10:00.000Z"));
    expect(task.scheduledStart).toBeInstanceOf(Date);
  });
});

describe("listTasksForDay", () => {
  it("propagates a query error as ExternalServiceError, not a raw Supabase error", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: async () => ({ data: null, error: { message: "connection refused" } }),
          }),
        }),
      }),
    } as never;
    await expect(listTasksForDay(supabase, "day-1")).rejects.toThrow();
  });
});
