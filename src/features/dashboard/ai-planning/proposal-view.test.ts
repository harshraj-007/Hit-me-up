import { describe, expect, it } from "vitest";
import { proposalViewFromGenerated, proposalViewFromPersisted } from "./proposal-view";
import type { AiProposalResult } from "@/server/services/ai-planning";
import type { AiProposal } from "@/server/db/repositories/ai-proposals";

const GENERATED: AiProposalResult = {
  proposalId: "p1",
  understood: "Move gym to 8pm.",
  unresolved: ["give the assignment an extra hour"],
  validation: {
    status: "valid",
    baseRevision: 3,
    accepted: [
      {
        changeIndex: 0,
        ref: "t1",
        taskId: "task-1",
        dayId: "day-1",
        reason: "You asked for gym after 8.",
        kind: "move",
        previousStart: new Date("2026-10-01T17:00:00Z"),
        previousEnd: new Date("2026-10-01T18:00:00Z"),
        previousUnscheduled: false,
        newStart: new Date("2026-10-01T20:00:00Z"),
        newEnd: new Date("2026-10-01T21:00:00Z"),
      },
    ],
    rejected: [
      { code: "locked_task", message: "Locked task can't move.", changeIndex: 1, ref: "t2" },
    ],
    conflictsAfter: [
      {
        firstTaskId: "task-1",
        secondTaskId: "task-3",
        firstRef: "t1",
        secondRef: "t3",
        involvesProposal: true,
      },
    ],
  },
};

const PERSISTED: AiProposal = {
  id: "p1",
  dayId: "day-1",
  baseRevision: 3,
  source: "voice",
  transcriptText: "move gym to 8pm",
  understood: "Move gym to 8pm.",
  unresolved: ["give the assignment an extra hour"],
  changes: [{ ref: "t1", task_id: "task-1", type: "move", new_start: "2026-10-01T20:00:00.000Z" }],
  rejected: [
    { code: "locked_task", message: "Locked task can't move.", changeIndex: 1, ref: "t2" },
  ],
  conflictsAfter: [
    {
      firstTaskId: "task-1",
      secondTaskId: "task-3",
      firstRef: "t1",
      secondRef: "t3",
      involvesProposal: true,
    },
  ],
  validationStatus: "valid",
  status: "generated",
  createdAt: new Date("2026-10-01T09:00:00Z"),
  confirmedAt: null,
  appliedRevisionNumber: null,
  briefingId: null,
};

describe("proposalViewFromGenerated", () => {
  it("maps a move with its reason and computed newStart", () => {
    const view = proposalViewFromGenerated(GENERATED);
    expect(view).toMatchObject({
      proposalId: "p1",
      understood: "Move gym to 8pm.",
      status: "valid",
      baseRevision: 3,
      isStale: false,
      conflictCount: 1,
    });
    expect(view.accepted).toEqual([
      {
        ref: "t1",
        kind: "move",
        taskId: "task-1",
        newStart: new Date("2026-10-01T20:00:00Z"),
        create: null,
        reason: "You asked for gym after 8.",
      },
    ]);
    expect(view.rejectedMessages).toEqual(["Locked task can't move."]);
  });

  it("maps an unschedule with a null newStart", () => {
    const result: AiProposalResult = {
      ...GENERATED,
      validation: {
        ...GENERATED.validation,
        accepted: [
          {
            changeIndex: 0,
            ref: "t1",
            taskId: "task-1",
            dayId: "day-1",
            reason: "x",
            kind: "unschedule",
            previousStart: new Date(),
            previousEnd: new Date(),
          },
        ],
      },
    };
    expect(proposalViewFromGenerated(result).accepted[0]).toMatchObject({
      kind: "unschedule",
      newStart: null,
    });
  });

  it("is never stale — a fresh generation is always current by construction", () => {
    expect(proposalViewFromGenerated(GENERATED).isStale).toBe(false);
  });
});

describe("proposalViewFromPersisted", () => {
  it("maps a stored move — same displayable facts, minus the in-memory-only reason", () => {
    const view = proposalViewFromPersisted(PERSISTED, false);
    expect(view.accepted).toEqual([
      {
        ref: "t1",
        kind: "move",
        taskId: "task-1",
        newStart: new Date("2026-10-01T20:00:00.000Z"),
        create: null,
        reason: null,
      },
    ]);
    expect(view.rejectedMessages).toEqual(["Locked task can't move."]);
    expect(view.conflictCount).toBe(1);
  });

  it("carries the staleness flag through untouched", () => {
    expect(proposalViewFromPersisted(PERSISTED, true).isStale).toBe(true);
    expect(proposalViewFromPersisted(PERSISTED, false).isStale).toBe(false);
  });

  it("maps a stored unschedule with a null newStart", () => {
    const proposal: AiProposal = {
      ...PERSISTED,
      changes: [{ ref: "t1", task_id: "task-1", type: "unschedule" }],
    };
    expect(proposalViewFromPersisted(proposal, false).accepted[0]).toMatchObject({
      kind: "unschedule",
      newStart: null,
    });
  });
});

describe("both mappers agree on the shape they produce", () => {
  it("the same underlying proposal maps to structurally equal views (aside from `reason`)", () => {
    const fromGenerated = proposalViewFromGenerated(GENERATED);
    const fromPersisted = proposalViewFromPersisted(PERSISTED, false);
    const strip = (v: typeof fromGenerated) => ({
      ...v,
      accepted: v.accepted.map(({ reason: _reason, ...rest }) => rest),
    });
    expect(strip(fromGenerated)).toEqual(strip(fromPersisted));
  });
});

describe("new tasks (Phase 8)", () => {
  const CREATE = {
    changeIndex: 0,
    ref: "n1",
    kind: "create" as const,
    title: "Deep work",
    start: new Date("2026-10-01T10:00:00Z"),
    end: new Date("2026-10-01T11:00:00Z"),
    durationMinutes: 60,
    priority: "high" as const,
    taskKind: "flexible" as const,
    reason: "Morning gap.",
  };

  it("maps a freshly generated create: no task id, the full new-task view, the model's reason", () => {
    const view = proposalViewFromGenerated(
      { ...GENERATED, validation: { ...GENERATED.validation, accepted: [CREATE] } },
      true,
    );
    expect(view.fromBriefing).toBe(true);
    expect(view.accepted).toEqual([
      {
        ref: "n1",
        kind: "create",
        taskId: null,
        newStart: null,
        create: {
          title: "Deep work",
          start: CREATE.start,
          end: CREATE.end,
          durationMinutes: 60,
          priority: "high",
          taskKind: "flexible",
        },
        reason: "Morning gap.",
      },
    ]);
  });

  it("a resumed (persisted) create shows the same facts, deriving the end from start + minutes", () => {
    const view = proposalViewFromPersisted(
      {
        ...PERSISTED,
        briefingId: "b1",
        changes: [
          {
            ref: "n1",
            type: "create",
            title: "Deep work",
            start: "2026-10-01T10:00:00.000Z",
            duration_minutes: 45,
            priority: "low",
            kind: "optional",
          },
          { ref: "t1", task_id: "task-1", type: "move", new_start: "2026-10-01T20:00:00.000Z" },
        ],
      },
      false,
    );
    expect(view.fromBriefing).toBe(true);
    expect(view.accepted[0]).toMatchObject({
      kind: "create",
      taskId: null,
      create: {
        title: "Deep work",
        end: new Date("2026-10-01T10:45:00.000Z"),
        durationMinutes: 45,
        priority: "low",
        taskKind: "optional",
      },
    });
    expect(view.accepted[1]).toMatchObject({ kind: "move", taskId: "task-1", create: null });
  });

  it("an ordinary Ask-AI proposal is not marked as from a briefing", () => {
    expect(proposalViewFromGenerated(GENERATED).fromBriefing).toBe(false);
    expect(proposalViewFromPersisted(PERSISTED, false).fromBriefing).toBe(false);
  });
});
