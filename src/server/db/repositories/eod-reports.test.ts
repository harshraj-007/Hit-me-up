import { describe, expect, it, vi } from "vitest";
import { ExternalServiceError, ValidationError } from "@/server/errors";
import { createEodReport, findEodReportForState, findLatestEodReport } from "./eod-reports";

const FACTS = {
  planningDate: "2026-10-01",
  timezone: "UTC",
  asOf: "2026-10-01T21:00",
  tasks: [
    {
      ref: "t1",
      title: "Write",
      priority: "medium",
      kind: "flexible",
      outcome: "slipped",
      start: "2026-10-01T09:00",
      end: "2026-10-01T10:00",
      durationMinutes: 60,
      completedAt: null,
      minutesLate: 660,
      rescheduleCount: 0,
      netShiftMinutes: null,
    },
  ],
  totals: {
    total: 1,
    completed: 0,
    completedOnTime: 0,
    completedLate: 0,
    skipped: 0,
    unresolved: 1,
    slipped: 1,
    inProgress: 0,
    notYetDue: 0,
    unscheduled: 0,
    completionRatio: 0,
    plannedMinutes: 60,
    completedMinutes: 0,
    skippedMinutes: 0,
    unresolvedMinutes: 60,
    highPriorityTotal: 0,
    highPriorityCompleted: 0,
    rescheduledTasks: 0,
    totalReschedules: 0,
    planRevisions: 0,
  },
};
const INTERP = { summary: "s", takeaway: "t", patterns: [], carryForward: [] };
const ROW = {
  id: "r1",
  user_id: "u1",
  day_id: "d1",
  state_fingerprint: "a".repeat(64),
  prompt_version: "v1",
  facts: FACTS,
  interpretation: INTERP,
  created_at: "2026-10-01T21:00:00Z",
};
const INPUT = {
  dayId: "d1",
  stateFingerprint: "a".repeat(64),
  promptVersion: "v1",
  facts: FACTS as never,
  interpretation: INTERP,
};

function rpcClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  return { rpc, client: { rpc } as never };
}

describe("createEodReport (the only writer)", () => {
  it("calls create_eod_report with exactly the day, fingerprint, version, facts and interpretation — no user id", async () => {
    const { rpc, client } = rpcClient({ data: ROW, error: null });
    const report = await createEodReport(client, INPUT);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("create_eod_report", {
      p_day_id: "d1",
      p_state_fingerprint: "a".repeat(64),
      p_prompt_version: "v1",
      p_facts: FACTS,
      p_interpretation: INTERP,
    });
    expect(report).toMatchObject({
      id: "r1",
      dayId: "d1",
      promptVersion: "v1",
      stateFingerprint: "a".repeat(64),
      createdAt: new Date("2026-10-01T21:00:00Z"),
    });
    expect(Object.keys((rpc.mock.calls[0] as unknown as unknown[])[1] as object)).not.toContain(
      "p_user_id",
    );
  });

  it.each([
    ["54000", ValidationError],
    ["22023", ValidationError],
    ["P0002", ExternalServiceError],
    ["XX000", ExternalServiceError],
  ])("maps SQLSTATE %s without leaking the database error", async (code, Cls) => {
    const { client } = rpcClient({
      data: null,
      error: { code, message: "SECRET db detail", details: "x" },
    });
    const error = await createEodReport(client, INPUT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Cls);
    expect(String((error as Error).message)).not.toContain("SECRET");
  });

  it("does not trust a row that fails the stored-shape check (a malformed jsonb column)", async () => {
    const { client } = rpcClient({ data: { ...ROW, interpretation: { summary: 5 } }, error: null });
    await expect(createEodReport(client, INPUT)).rejects.toThrow();
  });
});

describe("reads", () => {
  function selectClient(result: { data: unknown; error: unknown }, seen: string[]) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: string) => (seen.push(`eq:${c}=${v}`), chain),
      order: (c: string, o: { ascending: boolean }) => (
        seen.push(`order:${c}:${o.ascending}`),
        chain
      ),
      limit: (n: number) => (seen.push(`limit:${n}`), chain),
      maybeSingle: async () => result,
    };
    return { from: (t: string) => (seen.push(`from:${t}`), chain) } as never;
  }

  it("findLatestEodReport reads the newest row for the day, only", async () => {
    const seen: string[] = [];
    const report = await findLatestEodReport(selectClient({ data: ROW, error: null }, seen), "d1");
    expect(report?.id).toBe("r1");
    expect(seen).toEqual(["from:eod_reports", "eq:day_id=d1", "order:created_at:false", "limit:1"]);
  });

  it("findEodReportForState reads by day AND fingerprint", async () => {
    const seen: string[] = [];
    await findEodReportForState(
      selectClient({ data: ROW, error: null }, seen),
      "d1",
      "f".repeat(64),
    );
    expect(seen).toEqual([
      "from:eod_reports",
      `eq:day_id=d1`,
      `eq:state_fingerprint=${"f".repeat(64)}`,
    ]);
  });

  it("returns null when nothing matches", async () => {
    expect(
      await findLatestEodReport(selectClient({ data: null, error: null }, []), "d1"),
    ).toBeNull();
    expect(
      await findEodReportForState(selectClient({ data: null, error: null }, []), "d1", "f"),
    ).toBeNull();
  });

  it("wraps a database failure without leaking it", async () => {
    await expect(
      findLatestEodReport(
        selectClient({ data: null, error: { code: "XX000", message: "SECRET" } }, []),
        "d1",
      ),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("no write path other than the RPC", () => {
  it("exports exactly the writer and two readers", async () => {
    const mod = await import("./eod-reports");
    expect(Object.keys(mod).sort()).toEqual([
      "createEodReport",
      "findEodReportForState",
      "findLatestEodReport",
    ]);
  });
});
