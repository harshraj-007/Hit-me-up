import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserForAction: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({})),
}));
vi.mock("@/server/db/repositories/tasks", () => ({
  getTaskById: vi.fn(),
  changeTaskStatus: vi.fn(),
  createTask: vi.fn(),
}));
vi.mock("./day", () => ({ resolveCurrentDay: vi.fn() }));

import { requireUserForAction } from "@/server/auth/session";
import { getTaskById, changeTaskStatus, createTask } from "@/server/db/repositories/tasks";
import { AuthenticationError, NotFoundError, ValidationError } from "@/server/errors";
import type { Task } from "@/domain/tasks";
import { resolveCurrentDay } from "./day";
import { createTaskForDay, updateTaskStatusForUser } from "./tasks";

const VALID_TASK_ID = "11111111-1111-4111-8111-111111111111";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: VALID_TASK_ID,
    userId: "user-1",
    dayId: "day-1",
    title: "Write the report",
    notes: null,
    status: "upcoming",
    priority: "medium",
    kind: "flexible",
    source: "user",
    scheduledStart: new Date("2026-09-22T09:00:00Z"),
    scheduledEnd: new Date("2026-09-22T09:30:00Z"),
    dueAt: null,
    completedAt: null,
    scheduleLocked: false,
    unscheduled: false,
    createdAt: new Date("2026-09-22T08:00:00Z"),
    updatedAt: new Date("2026-09-22T08:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUserForAction).mockResolvedValue({ id: "user-1", email: "a@b.com" });
  vi.mocked(resolveCurrentDay).mockResolvedValue({
    id: "day-1",
    userId: "user-1",
    localDate: "2026-09-22",
    timezone: "UTC",
  });
});

describe("updateTaskStatusForUser", () => {
  it("propagates AuthenticationError for a signed-out caller without touching the database", async () => {
    vi.mocked(requireUserForAction).mockRejectedValueOnce(new AuthenticationError());
    await expect(
      updateTaskStatusForUser({ taskId: VALID_TASK_ID, status: "completed" }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(getTaskById).not.toHaveBeenCalled();
  });

  it("rejects malformed input before touching the database", async () => {
    await expect(
      updateTaskStatusForUser({ taskId: "not-a-uuid", status: "completed" }),
    ).rejects.toThrow();
    expect(getTaskById).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the task doesn't exist (also covers 'not yours' — RLS makes it invisible)", async () => {
    vi.mocked(getTaskById).mockResolvedValue(null);
    await expect(
      updateTaskStatusForUser({ taskId: VALID_TASK_ID, status: "completed" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(changeTaskStatus).not.toHaveBeenCalled();
  });

  it.each(["completed", "skipped"] as const)(
    "refuses to move an already-%s task, without calling the database",
    async (resolvedStatus) => {
      vi.mocked(getTaskById).mockResolvedValue(makeTask({ status: resolvedStatus }));
      await expect(
        updateTaskStatusForUser({ taskId: VALID_TASK_ID, status: "completed" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(changeTaskStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects 'late' as a target — it is derived from the clock, not a mutation", async () => {
    await expect(
      updateTaskStatusForUser({ taskId: VALID_TASK_ID, status: "late" }),
    ).rejects.toThrow();
    expect(getTaskById).not.toHaveBeenCalled();
    expect(changeTaskStatus).not.toHaveBeenCalled();
  });

  it("lets an overdue (derived-late) task be completed: it is still 'upcoming' in storage", async () => {
    vi.mocked(getTaskById).mockResolvedValue(
      makeTask({ status: "upcoming", scheduledEnd: new Date("2000-01-01T00:00:00Z") }),
    );
    vi.mocked(changeTaskStatus).mockResolvedValue(makeTask({ status: "completed" }));
    await updateTaskStatusForUser({ taskId: VALID_TASK_ID, status: "completed" });
    expect(changeTaskStatus).toHaveBeenCalled();
  });

  it("persists a valid transition and returns exactly what the repository returned", async () => {
    vi.mocked(getTaskById).mockResolvedValue(makeTask({ status: "upcoming" }));
    const persisted = makeTask({ status: "completed", completedAt: new Date() });
    vi.mocked(changeTaskStatus).mockResolvedValue(persisted);

    const result = await updateTaskStatusForUser({ taskId: VALID_TASK_ID, status: "completed" });

    expect(result).toBe(persisted);
    expect(changeTaskStatus).toHaveBeenCalledWith(expect.anything(), VALID_TASK_ID, "completed");
  });
});

describe("createTaskForDay", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T08:00:00Z")); // inside the mocked day, 2026-09-22 UTC
  });
  afterEach(() => vi.useRealTimers());

  it("rejects invalid input before resolving the day or touching the database", async () => {
    await expect(
      createTaskForDay({ title: "", scheduledStart: new Date(), scheduledEnd: new Date() }),
    ).rejects.toThrow();
    expect(resolveCurrentDay).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("resolves the caller's current day server-side and creates the task on it", async () => {
    const persisted = makeTask();
    vi.mocked(createTask).mockResolvedValue(persisted);
    const start = new Date("2026-09-22T10:00:00Z");
    const end = new Date("2026-09-22T10:30:00Z");

    const result = await createTaskForDay({
      title: "Write the report",
      scheduledStart: start,
      scheduledEnd: end,
    });

    expect(result).toBe(persisted);
    expect(resolveCurrentDay).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(createTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dayId: "day-1", title: "Write the report" }),
    );
  });
});
