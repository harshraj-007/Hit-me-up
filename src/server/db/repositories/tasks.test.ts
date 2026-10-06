import { describe, expect, it, vi } from "vitest";
import {
  AiConfirmationError,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import type { ConfirmationChange } from "@/domain/ai-planning";
import {
  applyReplan,
  changeTaskStatus,
  confirmAiProposal,
  listSpilloverTasks,
  listTasksForDay,
  rescheduleTask,
  toConfirmChangeRow,
} from "./tasks";

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

describe("rescheduleTask / applyReplan", () => {
  const start = new Date("2026-09-22T10:00:00.000Z");
  const end = new Date("2026-09-22T11:00:00.000Z");
  const row = {
    id: "t1",
    user_id: "u",
    day_id: "d",
    title: "x",
    notes: null,
    status: "upcoming",
    priority: "medium",
    kind: "flexible",
    source: "user",
    scheduled_start: start.toISOString(),
    scheduled_end: end.toISOString(),
    due_at: null,
    completed_at: null,
    schedule_locked: true,
    unscheduled: false,
    created_at: start.toISOString(),
    updated_at: start.toISOString(),
  };

  it("rescheduleTask sends only ids and ISO times, and maps the row", async () => {
    const supabase = fakeSupabase({ data: row, error: null });
    const task = await rescheduleTask(supabase, "t1", start, end);
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "reschedule_task",
      { p_task_id: "t1", p_start: start.toISOString(), p_end: end.toISOString() },
    );
    expect(task).toMatchObject({ scheduleLocked: true, unscheduled: false });
  });

  it.each([
    ["P0002", NotFoundError],
    ["22023", ValidationError],
    ["XX000", ExternalServiceError],
  ] as const)("rescheduleTask maps %s to the right AppError", async (code, errorClass) => {
    const supabase = fakeSupabase({ data: null, error: { code, message: "boom" } });
    await expect(rescheduleTask(supabase, "t1", start, end)).rejects.toBeInstanceOf(errorClass);
  });

  const change = {
    taskId: "t1",
    previousStart: start,
    previousEnd: end,
    previousUnscheduled: false,
    newStart: end,
    newEnd: new Date(end.getTime() + 3_600_000),
    newUnscheduled: false,
  };

  it("applyReplan sends snake_case changes and returns the revision number", async () => {
    const supabase = fakeSupabase({ data: 3, error: null });
    await expect(applyReplan(supabase, "day-1", [change])).resolves.toBe(3);
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "apply_replan",
      {
        p_day_id: "day-1",
        p_changes: [
          {
            task_id: "t1",
            previous_start: start.toISOString(),
            previous_end: end.toISOString(),
            previous_unscheduled: false,
            new_start: end.toISOString(),
            new_end: "2026-09-22T12:00:00.000Z",
            new_unscheduled: false,
          },
        ],
      },
    );
  });

  it("applyReplan returns null when nothing changed", async () => {
    await expect(
      applyReplan(fakeSupabase({ data: null, error: null }), "d", []),
    ).resolves.toBeNull();
  });

  it("applyReplan turns a stale-write (40001) into a retryable ValidationError", async () => {
    const supabase = fakeSupabase({ data: null, error: { code: "40001", message: "stale" } });
    await expect(applyReplan(supabase, "d", [change])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("listSpilloverTasks", () => {
  it("asks only for the previous day's unresolved, scheduled tasks that end after the day start", async () => {
    const seen: string[] = [];
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => (seen.push(`eq ${c}=${String(v)}`), chain),
      gt: (c: string, v: unknown) => (seen.push(`gt ${c}=${String(v)}`), chain),
      order: async () => ({ data: [], error: null }),
    };
    const supabase = { from: () => chain } as never;
    await listSpilloverTasks(supabase, "day-prev", new Date("2026-09-24T18:30:00.000Z"));
    expect(seen).toEqual([
      "eq day_id=day-prev",
      "eq status=upcoming",
      "eq unscheduled=false",
      "gt scheduled_end=2026-09-24T18:30:00.000Z",
    ]);
  });
});

describe("toConfirmChangeRow", () => {
  it("a move carries ref, task_id and new_start — and no other field", () => {
    const change: ConfirmationChange = {
      kind: "move",
      ref: "t1",
      taskId: "task-1",
      newStart: new Date("2026-10-01T20:00:00.000Z"),
    };
    expect(toConfirmChangeRow(change)).toEqual({
      ref: "t1",
      task_id: "task-1",
      type: "move",
      new_start: "2026-10-01T20:00:00.000Z",
    });
  });

  it("an unschedule carries no time field at all", () => {
    const change: ConfirmationChange = { kind: "unschedule", ref: "t2", taskId: "task-2" };
    const row = toConfirmChangeRow(change);
    expect(row).toEqual({ ref: "t2", task_id: "task-2", type: "unschedule" });
    expect(row).not.toHaveProperty("new_start");
  });

  it("a create carries exactly the seven wire fields — no end, id, source, notes or status", () => {
    const row = toConfirmChangeRow({
      kind: "create",
      ref: "n1",
      title: "Deep work",
      start: new Date("2026-10-01T10:00:00.000Z"),
      durationMinutes: 60,
      priority: "high",
      taskKind: "deadline",
    });
    expect(row).toEqual({
      ref: "n1",
      type: "create",
      title: "Deep work",
      start: "2026-10-01T10:00:00.000Z",
      duration_minutes: 60,
      priority: "high",
      kind: "deadline",
    });
    expect(Object.keys(row).sort()).toEqual(
      ["duration_minutes", "kind", "priority", "ref", "start", "title", "type"].sort(),
    );
  });
});

describe("confirmAiProposal", () => {
  const move: ConfirmationChange = {
    kind: "move",
    ref: "t1",
    taskId: "task-1",
    newStart: new Date("2026-10-01T20:00:00.000Z"),
  };

  it("sends the day, base revision, and snake_case changes, and returns the new revision", async () => {
    const rpc = vi.fn(async () => ({ data: 4, error: null }));
    const supabase = { rpc } as never;
    await expect(confirmAiProposal(supabase, "day-1", 3, [move])).resolves.toBe(4);
    expect(rpc).toHaveBeenCalledWith("confirm_ai_proposal", {
      p_day_id: "day-1",
      p_base_revision: 3,
      p_changes: [
        { ref: "t1", task_id: "task-1", type: "move", new_start: "2026-10-01T20:00:00.000Z" },
      ],
    });
  });

  it.each([
    ["40001", "stale_revision"],
    ["P0002", "task_ineligible"],
    ["23P01", "conflict"],
    ["22023", "invalid_proposal"],
  ] as const)("maps SQLSTATE %s to AiConfirmationError(%s)", async (code, reason) => {
    const supabase = fakeSupabase({ data: null, error: { code, message: "boom" } });
    const error = await confirmAiProposal(supabase, "day-1", 3, [move]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiConfirmationError);
    expect((error as AiConfirmationError).reason).toBe(reason);
  });

  it("wraps an unrecognized database error without leaking it", async () => {
    const supabase = fakeSupabase({
      data: null,
      error: { code: "XX000", message: "secret detail" },
    });
    await expect(confirmAiProposal(supabase, "day-1", 3, [move])).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });
});
