import { beforeEach, describe, expect, it, vi } from "vitest";

// The service must never use the Supabase client itself (only repositories may).
const DB_TOUCH = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      throw new Error("service touched the database client directly");
    },
  },
);
vi.mock("@/server/auth/session", () => ({ requireUserForAction: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => DB_TOUCH),
}));
vi.mock("@/server/db/repositories/tasks", () => ({ listTasksForDay: vi.fn() }));
vi.mock("@/server/db/repositories/task-history", () => ({ listTaskHistoryForTasks: vi.fn() }));
vi.mock("@/server/db/repositories/plan-revisions", () => ({ listRevisionNumbers: vi.fn() }));
vi.mock("@/server/db/repositories/eod-reports", () => ({
  createEodReport: vi.fn(),
  findEodReportForState: vi.fn(),
  findLatestEodReport: vi.fn(),
}));
vi.mock("./day", () => ({ todayLocalDate: vi.fn(), viewDay: vi.fn() }));
vi.mock("@/server/db/repositories/ai-usage", () => ({ reserveAiCall: vi.fn() }));

import { requireUserForAction } from "@/server/auth/session";
import { listTasksForDay } from "@/server/db/repositories/tasks";
import { listTaskHistoryForTasks } from "@/server/db/repositories/task-history";
import { listRevisionNumbers } from "@/server/db/repositories/plan-revisions";
import {
  createEodReport,
  findEodReportForState,
  findLatestEodReport,
} from "@/server/db/repositories/eod-reports";
import { AuthenticationError, ValidationError } from "@/server/errors";
import { AiError } from "@/server/ai/errors";
import { createFakeEodInterpreter } from "@/server/ai/fake";
import { EOD_PROMPT_VERSION } from "@/server/ai/eod-prompt";
import type { EodReport } from "@/domain/eod";
import type { Task, TaskHistoryEntry } from "@/domain/tasks";
import {
  at,
  DAY_ID,
  makeTask,
  OTHER_DAY_ID,
  USER_ID,
} from "../../../tests/support/ai-planning-fixtures";
import { todayLocalDate, viewDay } from "./day";
import { fingerprintTasks, generateEodReport, loadEodReportView } from "./eod-report";

const EVENING = at(21);
const TODAY = { todayLocal: "2026-10-01", profileTimezone: "UTC" };
const DAY = { id: DAY_ID, userId: USER_ID, localDate: "2026-10-01", timezone: "UTC" };
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const INTERPRETATION = {
  summary: "Most of the day went to plan.",
  patterns: [],
  carryForward: [{ ref: "t2", suggestion: "Give it the first slot tomorrow." }],
  takeaway: "Protect the afternoon.",
};

let dayTasks: Task[];
let history: TaskHistoryEntry[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireUserForAction).mockResolvedValue({ id: USER_ID, email: "alice@example.com" });
  vi.mocked(todayLocalDate).mockResolvedValue(TODAY);
  vi.mocked(viewDay).mockResolvedValue(DAY);
  dayTasks = [
    makeTask({
      title: "Gym",
      status: "completed",
      completedAt: at(8, 50),
      start: at(8),
      end: at(9),
    }),
    makeTask({ title: "Essay", start: at(14), end: at(16) }),
  ];
  history = [];
  vi.mocked(listTasksForDay).mockImplementation(async () => dayTasks);
  vi.mocked(listTaskHistoryForTasks).mockImplementation(async () => history);
  vi.mocked(listRevisionNumbers).mockResolvedValue([{ revisionNumber: 1 }]);
  vi.mocked(findEodReportForState).mockResolvedValue(null);
  vi.mocked(createEodReport).mockImplementation(async (_s, input) => ({
    id: "report-1",
    dayId: input.dayId,
    facts: input.facts,
    interpretation: input.interpretation,
    promptVersion: input.promptVersion,
    stateFingerprint: input.stateFingerprint,
    createdAt: EVENING,
  }));
});

const run = (interpreter = createFakeEodInterpreter(INTERPRETATION)) =>
  generateEodReport({ interpreter, now: () => EVENING });

describe("identity, day and date are server-owned", () => {
  it("requires an authenticated user and does nothing else without one", async () => {
    vi.mocked(requireUserForAction).mockRejectedValue(new AuthenticationError());
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await expect(run(interpreter)).rejects.toBeInstanceOf(AuthenticationError);
    expect(listTasksForDay).not.toHaveBeenCalled();
    expect(interpreter.calls).toHaveLength(0);
  });

  it("takes no date, day id or user id from its caller — it reviews TODAY, resolved from the profile clock", async () => {
    await run();
    expect(viewDay).toHaveBeenCalledWith(DB_TOUCH, USER_ID, "2026-10-01");
    expect(listTasksForDay).toHaveBeenCalledWith(DB_TOUCH, DAY_ID);
    // The only parameter is a bag of test seams — there is nowhere for a client to name a day.
    expect(generateEodReport.length).toBeLessThanOrEqual(1);
  });

  it("refuses while the timezone is unknown, reading and writing nothing", async () => {
    vi.mocked(todayLocalDate).mockResolvedValue(null);
    await expect(run()).rejects.toBeInstanceOf(ValidationError);
    expect(viewDay).not.toHaveBeenCalled();
    expect(createEodReport).not.toHaveBeenCalled();
  });

  it("refuses when today has no day row — reviewing never creates a day", async () => {
    vi.mocked(viewDay).mockResolvedValue(null);
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await expect(run(interpreter)).rejects.toBeInstanceOf(ValidationError);
    expect(interpreter.calls).toHaveLength(0);
    expect(createEodReport).not.toHaveBeenCalled();
  });
});

describe("an empty day", () => {
  it("is not an error and not a model call: nothing to review, nothing stored", async () => {
    dayTasks = [];
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await expect(run(interpreter)).resolves.toEqual({ kind: "empty" });
    expect(interpreter.calls).toHaveLength(0);
    expect(listTaskHistoryForTasks).not.toHaveBeenCalled();
    expect(createEodReport).not.toHaveBeenCalled();
  });

  it("a day beyond the per-review task limit is refused before any model call", async () => {
    dayTasks = Array.from({ length: 101 }, (_, i) =>
      makeTask({ title: `T${i}`, start: at(8), end: at(9) }),
    );
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await expect(run(interpreter)).rejects.toBeInstanceOf(ValidationError);
    expect(interpreter.calls).toHaveLength(0);
  });
});

describe("a partially completed day", () => {
  it("computes the facts deterministically, hands them to the model, and stores them untouched beside the interpretation", async () => {
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    const result = await run(interpreter);

    expect(result.kind).toBe("report");
    if (result.kind !== "report") return;
    expect(result.reused).toBe(false);
    expect(result.view.isStale).toBe(false);

    const shown = interpreter.calls[0]!.facts;
    expect(shown.tasks.map((t) => [t.ref, t.title, t.outcome])).toEqual([
      ["t1", "Gym", "completed_on_time"],
      ["t2", "Essay", "slipped"],
    ]);
    expect(shown.totals).toMatchObject({ total: 2, completed: 1, slipped: 1, unresolved: 1 });
    expect(shown.asOf).toBe("2026-10-01T21:00");

    const [, input] = vi.mocked(createEodReport).mock.calls[0]!;
    expect(input.facts).toBe(shown); // exactly what the model saw is what is stored
    expect(input.dayId).toBe(DAY_ID);
    expect(input.promptVersion).toBe(EOD_PROMPT_VERSION);
    expect(input.stateFingerprint).toMatch(HEX64);
    expect(input.interpretation.takeaway).toBe("Protect the afternoon.");
  });

  it("the model can interpret but never alter a fact: whatever it claims, stored facts come from the database", async () => {
    const lying = createFakeEodInterpreter({
      ...INTERPRETATION,
      summary: "Everything was completed.", // prose may be wrong about the day…
    });
    const result = await run(lying);
    if (result.kind !== "report") throw new Error("expected a report");
    // …but the facts beside it say what really happened.
    expect(result.view.report.facts.totals).toMatchObject({ completed: 1, unresolved: 1 });
    expect(result.view.report.facts.tasks[1]!.outcome).toBe("slipped");
  });

  it("includes what moved from task history and the plan's revision count", async () => {
    const essay = dayTasks[1]!;
    history = [
      {
        id: "h1",
        taskId: essay.id,
        event: "rescheduled",
        previousStatus: "upcoming",
        newStatus: "upcoming",
        source: "user",
        previousStart: at(10),
        previousEnd: at(12),
        newStart: at(14),
        newEnd: at(16),
        revisionId: null,
        changedAt: at(9),
      },
    ];
    vi.mocked(listRevisionNumbers).mockResolvedValue(
      [1, 2, 3].map((revisionNumber) => ({ revisionNumber })),
    );
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await run(interpreter);
    const shown = interpreter.calls[0]!.facts;
    expect(shown.tasks[1]).toMatchObject({ rescheduleCount: 1, netShiftMinutes: 240 });
    expect(shown.totals).toMatchObject({ rescheduledTasks: 1, planRevisions: 2 });
    expect(listTaskHistoryForTasks).toHaveBeenCalledWith(
      DB_TOUCH,
      dayTasks.map((t) => t.id),
    );
  });

  it("reads the day in the DAY's frozen timezone, not the profile's current one", async () => {
    vi.mocked(viewDay).mockResolvedValue({ ...DAY, timezone: "Asia/Calcutta" });
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await run(interpreter);
    expect(interpreter.calls[0]!.facts.timezone).toBe("Asia/Calcutta");
    expect(interpreter.calls[0]!.facts.tasks[0]!.start).toBe("2026-10-01T13:30");
  });
});

describe("cross-midnight and scope", () => {
  it("reviews a task that starts today and ends after midnight as part of TODAY, still in progress", async () => {
    dayTasks = [makeTask({ title: "Night shift", start: at(23), end: at(1, 0, 1) })];
    const interpreter = createFakeEodInterpreter({ ...INTERPRETATION, carryForward: [] });
    await generateEodReport({ interpreter, now: () => at(23, 30) });
    expect(interpreter.calls[0]!.facts.tasks[0]).toMatchObject({
      outcome: "in_progress",
      start: "2026-10-01T23:00",
      end: "2026-10-02T01:00",
    });
  });

  it("never includes yesterday's spillover: a task belonging to another day is excluded even if a read returned it", async () => {
    dayTasks = [
      ...dayTasks,
      makeTask({
        title: "Yesterday's spillover",
        dayId: OTHER_DAY_ID,
        start: at(22, 0, -1),
        end: at(2),
      }),
    ];
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await run(interpreter);
    expect(interpreter.calls[0]!.facts.tasks.map((t) => t.title)).not.toContain(
      "Yesterday's spillover",
    );
    expect(interpreter.calls[0]!.facts.totals.total).toBe(2);
  });

  it("never includes another user's task even if a read returned one (RLS is not the only check)", async () => {
    dayTasks = [
      ...dayTasks,
      makeTask({ title: "Someone else's", userId: "other-user", start: at(9), end: at(10) }),
    ];
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await run(interpreter);
    expect(interpreter.calls[0]!.facts.tasks.map((t) => t.title)).not.toContain("Someone else's");
  });
});

describe("what the model is allowed to see", () => {
  it("receives titles and computed facts only — no task id, note, user id, email or UUID", async () => {
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await run(interpreter);
    const json = JSON.stringify(interpreter.calls[0]!.facts);
    expect(json).toContain("Gym");
    expect(json).not.toMatch(UUID);
    expect(json).not.toContain("PRIVATE-NOTES-DO-NOT-LEAK");
    expect(json).not.toContain("alice@example.com");
    expect(json).not.toContain(USER_ID);
  });
});

describe("idempotency", () => {
  const existing = (over: Partial<EodReport> = {}): EodReport =>
    ({ id: "existing", dayId: DAY_ID, stateFingerprint: "x", ...over }) as EodReport;

  it("an unchanged day is a replay: the existing report is returned with NO model call, no history read and no write", async () => {
    vi.mocked(findEodReportForState).mockResolvedValue(existing());
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    const result = await run(interpreter);
    expect(result).toMatchObject({ kind: "report", reused: true, view: { isStale: false } });
    expect(interpreter.calls).toHaveLength(0);
    expect(listTaskHistoryForTasks).not.toHaveBeenCalled();
    expect(createEodReport).not.toHaveBeenCalled();
  });

  it("looks the report up by the CURRENT state's fingerprint", async () => {
    await run();
    expect(findEodReportForState).toHaveBeenCalledWith(
      DB_TOUCH,
      DAY_ID,
      fingerprintTasks(dayTasks),
    );
  });

  it("a changed day produces a new report (a different fingerprint)", async () => {
    await run();
    const before = vi.mocked(createEodReport).mock.calls[0]![1].stateFingerprint;
    dayTasks = [{ ...dayTasks[1]!, status: "skipped" }, dayTasks[0]!];
    await run();
    const after = vi.mocked(createEodReport).mock.calls[1]![1].stateFingerprint;
    expect(after).not.toBe(before);
  });
});

describe("failures persist nothing", () => {
  const rejects = async (interpreter: ReturnType<typeof createFakeEodInterpreter>) => {
    const error = await run(interpreter).then(
      () => null,
      (e: unknown) => e,
    );
    expect(createEodReport).not.toHaveBeenCalled();
    return error;
  };

  it.each(["timeout", "rate_limited", "provider_error", "unavailable", "cancelled"] as const)(
    "a provider failure (%s) surfaces as a sanitized AiError and writes nothing",
    async (reason) => {
      const error = await rejects(
        createFakeEodInterpreter(() => {
          throw new AiError(reason, undefined, "review");
        }),
      );
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).reason).toBe(reason);
    },
  );

  it.each([
    ["not an object", "I think you did well"],
    ["missing fields", { summary: "x" }],
    ["a hidden extra field", { ...INTERPRETATION, markDone: ["t2"] }],
    ["a fabricated task in the summary", { ...INTERPRETATION, summary: "[t9] was the highlight." }],
    ["a number in the takeaway", { ...INTERPRETATION, takeaway: "Finish 3 things." }],
  ])(
    "malformed model output (%s) is malformed_response and writes nothing",
    async (_l, payload) => {
      const error = await rejects(createFakeEodInterpreter(payload));
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).reason).toBe("malformed_response");
    },
  );

  it("a fabricated carry-forward (a COMPLETED task) is dropped but the rest of the report is still stored", async () => {
    const interpreter = createFakeEodInterpreter({
      ...INTERPRETATION,
      carryForward: [
        { ref: "t1", suggestion: "Do the gym again." }, // t1 is completed
        { ref: "t2", suggestion: "Give it the first slot tomorrow." },
      ],
    });
    const result = await run(interpreter);
    if (result.kind !== "report") throw new Error("expected a report");
    expect(result.view.report.interpretation.carryForward).toEqual([
      { ref: "t2", suggestion: "Give it the first slot tomorrow." },
    ]);
  });

  it("a persistence failure is not swallowed — the caller never gets a report that wasn't saved", async () => {
    vi.mocked(createEodReport).mockRejectedValue(new Error("db down"));
    await expect(run()).rejects.toThrow("db down");
  });

  it("a caller abort reaches the provider", async () => {
    const controller = new AbortController();
    const interpreter = createFakeEodInterpreter(INTERPRETATION);
    await generateEodReport({ interpreter, now: () => EVENING, signal: controller.signal });
    expect(interpreter.calls[0]!.options?.signal).toBe(controller.signal);
  });
});

describe("loadEodReportView (staleness is a live comparison, never stored)", () => {
  const tasks = [makeTask({ title: "A", start: at(9), end: at(10) })];
  const report = (fingerprint: string, id = "r"): EodReport =>
    ({ id, stateFingerprint: fingerprint }) as EodReport;

  it("is null when there is no report", async () => {
    vi.mocked(findLatestEodReport).mockResolvedValue(null);
    await expect(loadEodReportView(DB_TOUCH as never, DAY_ID, tasks)).resolves.toBeNull();
  });

  it("is fresh when the newest report was written against exactly the current state", async () => {
    vi.mocked(findLatestEodReport).mockResolvedValue(report(fingerprintTasks(tasks)));
    await expect(loadEodReportView(DB_TOUCH as never, DAY_ID, tasks)).resolves.toMatchObject({
      isStale: false,
    });
    expect(findEodReportForState).not.toHaveBeenCalled();
  });

  it("is stale when the day's persisted state has changed since", async () => {
    vi.mocked(findLatestEodReport).mockResolvedValue(report("0".repeat(64)));
    vi.mocked(findEodReportForState).mockResolvedValue(null);
    await expect(loadEodReportView(DB_TOUCH as never, DAY_ID, tasks)).resolves.toMatchObject({
      isStale: true,
      report: { id: "r" },
    });
  });

  it("prefers an OLDER report written against the current state (a task moved back) over a newer, stale one", async () => {
    vi.mocked(findLatestEodReport).mockResolvedValue(report("0".repeat(64), "newer"));
    vi.mocked(findEodReportForState).mockResolvedValue(report(fingerprintTasks(tasks), "older"));
    await expect(loadEodReportView(DB_TOUCH as never, DAY_ID, tasks)).resolves.toMatchObject({
      isStale: false,
      report: { id: "older" },
    });
  });

  it("does not go stale merely because the clock moved: the fingerprint has no time input", () => {
    expect(fingerprintTasks(tasks)).toBe(
      fingerprintTasks(tasks.map((t) => ({ ...t, updatedAt: at(23) }))),
    );
  });
});
