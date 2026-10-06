import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared per-user AI budget, from the services' side (Phase 9). The repository and the SQL are
 * tested on their own; this file proves WHERE the reservation sits in each of the three model-calling
 * services and what it does to the flow around it:
 *
 *   reserved BEFORE anything is read for a prompt and BEFORE the provider; a refusal means no
 *   provider call and no further work; a failed budget check fails closed; a provider failure is
 *   not refunded; invalid or no-op requests cost nothing; resuming/confirming/discarding a stored
 *   proposal never touches the budget.
 */
const DB_TOUCH = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      throw new Error("service touched the database client directly");
    },
  },
);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserForAction: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => DB_TOUCH),
}));
vi.mock("@/server/db/repositories/tasks", () => ({
  listTasksForDay: vi.fn(),
  listSpilloverTasks: vi.fn(),
  confirmAiProposal: vi.fn(),
}));
vi.mock("@/server/db/repositories/plans", () => ({ getLatestRevisionNumber: vi.fn() }));
vi.mock("@/server/db/repositories/briefings", () => ({
  getLatestBriefingForDay: vi.fn(),
  getLatestBriefing: vi.fn(),
}));
vi.mock("@/server/db/repositories/ai-proposals", () => ({
  createAiProposal: vi.fn(),
  findPendingProposal: vi.fn(),
  getAiProposalById: vi.fn(),
  confirmAiProposalById: vi.fn(),
  discardAiProposal: vi.fn(),
}));
vi.mock("@/server/db/repositories/ai-usage", () => ({ reserveAiCall: vi.fn() }));
vi.mock("@/server/db/repositories/eod-reports", () => ({
  createEodReport: vi.fn(),
  findEodReportForState: vi.fn(),
  findLatestEodReport: vi.fn(),
}));
vi.mock("@/server/db/repositories/task-history", () => ({ listTaskHistoryForTasks: vi.fn() }));
vi.mock("@/server/db/repositories/plan-revisions", () => ({ listRevisionNumbers: vi.fn() }));
vi.mock("./day", () => ({ todayLocalDate: vi.fn(), viewDay: vi.fn() }));

import { requireUserForAction } from "@/server/auth/session";
import { listSpilloverTasks, listTasksForDay } from "@/server/db/repositories/tasks";
import { getLatestRevisionNumber } from "@/server/db/repositories/plans";
import { getLatestBriefingForDay } from "@/server/db/repositories/briefings";
import {
  confirmAiProposalById,
  createAiProposal,
  discardAiProposal,
  findPendingProposal,
  getAiProposalById,
} from "@/server/db/repositories/ai-proposals";
import { reserveAiCall } from "@/server/db/repositories/ai-usage";
import { createEodReport, findEodReportForState } from "@/server/db/repositories/eod-reports";
import { listTaskHistoryForTasks } from "@/server/db/repositories/task-history";
import { listRevisionNumbers } from "@/server/db/repositories/plan-revisions";
import { ExternalServiceError, RateLimitError, ValidationError } from "@/server/errors";
import { AiError } from "@/server/ai/errors";
import {
  createFakeBriefingGenerator,
  createFakeEodInterpreter,
  createFakeGenerator,
} from "@/server/ai/fake";
import type { Task } from "@/domain/tasks";
import {
  at,
  DAY_ID,
  makeTask,
  NOW,
  PLANNING_DATE,
  USER_ID,
} from "../../../tests/support/ai-planning-fixtures";
import { todayLocalDate, viewDay } from "./day";
import { generateAiProposal, loadPendingAiProposal } from "./ai-planning";
import { generateBriefingPlan } from "./briefing-plan";
import { generateEodReport } from "./eod-report";
import { confirmPersistedAiProposal, discardPersistedAiProposal } from "./ai-confirmation";

const TODAY = { todayLocal: "2026-10-01", profileTimezone: "UTC" };
const DAY = { id: DAY_ID, userId: USER_ID, localDate: "2026-10-01", timezone: "UTC" };
const REQUEST_ID = "0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6a77";
const EVENING = at(21);

let events: string[];
let own: Task[];

beforeEach(() => {
  vi.resetAllMocks();
  events = [];
  own = [makeTask({ title: "Gym", source: "user", start: at(17), end: at(18) })];
  vi.mocked(requireUserForAction).mockResolvedValue({ id: USER_ID, email: "alice@example.com" });
  vi.mocked(todayLocalDate).mockResolvedValue(TODAY);
  vi.mocked(viewDay).mockImplementation(async (_s, _u, date) =>
    date === "2026-10-01" ? DAY : null,
  );
  vi.mocked(getLatestRevisionNumber).mockResolvedValue(3);
  vi.mocked(listTasksForDay).mockImplementation(async () => {
    events.push("read tasks");
    return own;
  });
  vi.mocked(listSpilloverTasks).mockResolvedValue([]);
  vi.mocked(getLatestBriefingForDay).mockResolvedValue({
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    rawText: "Finish the report",
    createdAt: NOW,
  });
  vi.mocked(findEodReportForState).mockResolvedValue(null);
  vi.mocked(listTaskHistoryForTasks).mockImplementation(async () => {
    events.push("read history");
    return [];
  });
  vi.mocked(listRevisionNumbers).mockResolvedValue([{ revisionNumber: 1 }]);
  vi.mocked(createAiProposal).mockImplementation(async (_s, input) => ({
    id: "p1",
    dayId: input.dayId,
    baseRevision: input.validation.baseRevision,
    source: input.source,
    transcriptText: input.transcriptText,
    understood: input.understood,
    unresolved: [],
    changes: [],
    rejected: [],
    conflictsAfter: [],
    validationStatus: input.validation.status,
    status: "generated",
    createdAt: NOW,
    confirmedAt: null,
    appliedRevisionNumber: null,
    briefingId: input.briefingId ?? null,
  }));
  vi.mocked(createEodReport).mockImplementation(async (_s, input) => ({
    id: "r1",
    dayId: input.dayId,
    facts: input.facts,
    interpretation: input.interpretation,
    promptVersion: input.promptVersion,
    stateFingerprint: input.stateFingerprint,
    createdAt: EVENING,
  }));
  vi.mocked(reserveAiCall).mockImplementation(async (_s, feature) => {
    events.push(`reserve ${feature}`);
  });
});

// ── the three model-calling paths, one shape ────────────────────────────────────────────────────
const askRequest = {
  id: REQUEST_ID,
  source: "typed",
  text: "move gym",
  planningDate: PLANNING_DATE,
};
const briefingRequest = { id: REQUEST_ID, source: "typed", note: "", planningDate: PLANNING_DATE };
const emptyAsk = { understood: "ok", changes: [], unresolved: [] };
const eodOk = { summary: "A day.", patterns: [], carryForward: [], takeaway: "Start earlier." };

interface Path {
  name: string;
  feature: "plan" | "briefing_plan" | "eod_review";
  /** The first read made FOR the prompt — the reservation must come before it. (The review reads the
   *  day's tasks earlier, only to learn whether there is anything to review at all.) */
  promptRead: string;
  /** Runs the service with a generator that records the moment the provider is reached. */
  run: (opts?: { fail?: boolean; request?: unknown }) => Promise<unknown>;
  providerCalls: () => number;
}

function makePaths(): Path[] {
  let planCalls = 0;
  let briefingCalls = 0;
  let eodCalls = 0;
  const reached = (label: string) => events.push(label);
  return [
    {
      name: "generateAiProposal (Ask AI)",
      feature: "plan",
      promptRead: "read tasks",
      providerCalls: () => planCalls,
      run: ({ fail, request } = {}) =>
        generateAiProposal(request ?? askRequest, {
          now: () => NOW,
          generator: {
            async propose() {
              planCalls += 1;
              reached("provider");
              if (fail) throw new AiError("provider_error");
              return emptyAsk;
            },
          },
        }),
    },
    {
      name: "generateBriefingPlan (Plan my day)",
      feature: "briefing_plan",
      promptRead: "read tasks",
      providerCalls: () => briefingCalls,
      run: ({ fail, request } = {}) =>
        generateBriefingPlan(request ?? briefingRequest, {
          now: () => NOW,
          generator: {
            async propose() {
              briefingCalls += 1;
              reached("provider");
              if (fail) throw new AiError("provider_error");
              return emptyAsk;
            },
          },
        }),
    },
    {
      name: "generateEodReport (Review the day)",
      feature: "eod_review",
      promptRead: "read history",
      providerCalls: () => eodCalls,
      run: ({ fail } = {}) =>
        generateEodReport({
          now: () => EVENING,
          interpreter: {
            async interpret() {
              eodCalls += 1;
              reached("provider");
              if (fail) throw new AiError("provider_error", undefined, "review");
              return eodOk;
            },
          },
        }),
    },
  ];
}

describe.each([
  "generateAiProposal (Ask AI)",
  "generateBriefingPlan (Plan my day)",
  "generateEodReport (Review the day)",
])("%s", (name) => {
  const path = () => makePaths().find((p) => p.name === name)!;

  it("reserves from the SHARED budget once, under its own feature name, BEFORE the provider is reached", async () => {
    const p = path();
    await p.run().catch(() => undefined);
    expect(reserveAiCall).toHaveBeenCalledTimes(1);
    expect(reserveAiCall).toHaveBeenCalledWith(DB_TOUCH, p.feature);
    const reserve = events.indexOf(`reserve ${p.feature}`);
    const provider = events.indexOf("provider");
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(provider).toBeGreaterThan(reserve);
  });

  it("reserves before anything is read for the prompt", async () => {
    const p = path();
    await p.run().catch(() => undefined);
    expect(events.indexOf(p.promptRead)).toBeGreaterThan(events.indexOf(`reserve ${p.feature}`));
  });

  it("an over-budget user gets a RateLimitError, the provider is never called, and nothing is read or written", async () => {
    const p = path();
    vi.mocked(reserveAiCall).mockRejectedValue(new RateLimitError(900));
    const error = await p.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).status).toBe(429);
    expect(p.providerCalls()).toBe(0);
    expect(events).not.toContain("provider");
    expect(events).not.toContain(p.promptRead);
    expect(createAiProposal).not.toHaveBeenCalled();
    expect(createEodReport).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED: if the budget cannot be checked, no model call is made", async () => {
    const p = path();
    vi.mocked(reserveAiCall).mockRejectedValue(new ExternalServiceError("supabase"));
    await expect(p.run()).rejects.toBeInstanceOf(ExternalServiceError);
    expect(p.providerCalls()).toBe(0);
  });

  it("a provider failure is NOT refunded: one reservation, no second call to anything budget-related", async () => {
    const p = path();
    await expect(p.run({ fail: true })).rejects.toBeInstanceOf(AiError);
    expect(p.providerCalls()).toBe(1);
    expect(reserveAiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reserveAiCall).mock.calls).toHaveLength(1);
  });

  it("an unauthenticated caller reserves nothing", async () => {
    const p = path();
    vi.mocked(requireUserForAction).mockRejectedValue(new Error("no session"));
    await expect(p.run()).rejects.toThrow("no session");
    expect(reserveAiCall).not.toHaveBeenCalled();
  });
});

describe("requests that make no model call cost nothing", () => {
  it("Ask AI: an invalid request is refused before any reservation", async () => {
    const generator = createFakeGenerator(emptyAsk);
    await expect(
      generateAiProposal({ ...askRequest, text: "   " }, { generator, now: () => NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(reserveAiCall).not.toHaveBeenCalled();
  });

  it("Ask AI: a day that doesn't exist yet is refused before any reservation", async () => {
    await expect(
      generateAiProposal(
        { ...askRequest, planningDate: "2026-10-02" },
        { generator: createFakeGenerator(emptyAsk), now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(reserveAiCall).not.toHaveBeenCalled();
  });

  it("Plan my day: no saved briefing, an invalid request or a client-supplied briefing reserve nothing", async () => {
    const generator = createFakeBriefingGenerator(emptyAsk);
    vi.mocked(getLatestBriefingForDay).mockResolvedValue(null);
    await expect(
      generateBriefingPlan(briefingRequest, { generator, now: () => NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      generateBriefingPlan({ ...briefingRequest, briefing: "x" }, { generator, now: () => NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(reserveAiCall).not.toHaveBeenCalled();
    expect(generator.calls).toHaveLength(0);
  });

  it("Review the day: an empty day makes no model call and reserves nothing", async () => {
    own = [];
    const interpreter = createFakeEodInterpreter(eodOk);
    expect(await generateEodReport({ interpreter, now: () => EVENING })).toEqual({ kind: "empty" });
    expect(reserveAiCall).not.toHaveBeenCalled();
    expect(interpreter.calls).toHaveLength(0);
  });

  it("Review the day: a report that already exists for this exact day-state is returned free of charge", async () => {
    vi.mocked(findEodReportForState).mockResolvedValue({
      id: "existing",
      dayId: DAY_ID,
      facts: {} as never,
      interpretation: {} as never,
      promptVersion: "v",
      stateFingerprint: "f".repeat(64),
      createdAt: EVENING,
    });
    const interpreter = createFakeEodInterpreter(eodOk);
    const result = await generateEodReport({ interpreter, now: () => EVENING });
    expect(result).toMatchObject({ kind: "report", reused: true });
    expect(reserveAiCall).not.toHaveBeenCalled();
    expect(interpreter.calls).toHaveLength(0);
  });
});

describe("stored proposals never touch the budget — they make no model call", () => {
  it("resuming (loadPendingAiProposal), confirming and discarding a stored proposal reserve nothing", async () => {
    vi.mocked(findPendingProposal).mockResolvedValue(null);
    await loadPendingAiProposal(PLANNING_DATE);

    vi.mocked(getAiProposalById).mockResolvedValue({
      id: REQUEST_ID,
      dayId: DAY_ID,
    } as never);
    vi.mocked(confirmAiProposalById).mockResolvedValue(2);
    vi.mocked(listTasksForDay).mockResolvedValue(own);
    await confirmPersistedAiProposal({ proposalId: REQUEST_ID });
    await discardPersistedAiProposal({ proposalId: REQUEST_ID });
    expect(discardAiProposal).toHaveBeenCalled();
    expect(confirmAiProposalById).toHaveBeenCalled();
    expect(reserveAiCall).not.toHaveBeenCalled();
  });
});
