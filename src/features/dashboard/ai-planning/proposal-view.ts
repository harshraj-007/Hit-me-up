import type { AiProposalResult } from "@/server/services/ai-planning";
import type { AiProposal } from "@/server/services/ai-confirmation";

/**
 * What the proposal review UI actually renders, in ONE shape regardless of where the proposal
 * came from: a fresh generation (`fromGenerated`, in-memory, full Phase 5.0 fidelity — a
 * `reason` for each accepted change) or a resumed, persisted one (`fromPersisted`, read back
 * from `ai_proposals` after a refresh — no `reason`, since the confirm wire shape
 * (`ConfirmChangeRow`) never stored one; see the migration). Both are pure mappings — nothing
 * here calls the server or decides eligibility; that stays entirely in `validateProposal`
 * (generation) and `confirm_ai_proposal_by_id` (confirmation).
 */

/** A task a plan would CREATE (Phase 8) — everything the review shows about it. */
export interface NewTaskView {
  title: string;
  start: Date;
  end: Date;
  durationMinutes: number;
  priority: "high" | "medium" | "low";
  taskKind: "flexible" | "deadline" | "optional" | "fixed";
}

export interface ProposalChangeView {
  /** `t1`… for an existing task, `n1`… for a new one (server-assigned either way). */
  ref: string;
  kind: "move" | "unschedule" | "create";
  /** The existing task a move/unschedule names — the review looks its title up in the day's own
   *  tasks, so the user sees WHICH task, not an alias. Null for a create (it has no id yet). */
  taskId: string | null;
  /** Local instant the task would move to; null for an unschedule or a create. */
  newStart: Date | null;
  /** The new task, for a create; null otherwise. */
  create: NewTaskView | null;
  /** Only present for a freshly generated proposal — see the module doc. */
  reason: string | null;
}

export interface ProposalView {
  proposalId: string;
  understood: string;
  unresolved: readonly string[];
  status: "valid" | "partially_valid" | "invalid";
  accepted: readonly ProposalChangeView[];
  rejectedMessages: readonly string[];
  conflictCount: number;
  baseRevision: number;
  /** True when the proposal was planned from the saved briefing ("Plan my day"), false for an
   *  ordinary "Ask AI" request. Decides only which words the review uses. */
  fromBriefing: boolean;
  /** True only for a resumed proposal whose base revision no longer matches the day's current
   *  one — a freshly generated proposal is never stale at the instant it is shown. */
  isStale: boolean;
}

export function proposalViewFromGenerated(
  result: AiProposalResult,
  fromBriefing = false,
): ProposalView {
  const { validation } = result;
  return {
    proposalId: result.proposalId,
    understood: result.understood,
    unresolved: result.unresolved,
    status: validation.status,
    accepted: validation.accepted.map((change): ProposalChangeView => {
      if (change.kind === "create") {
        return {
          ref: change.ref,
          kind: "create",
          taskId: null,
          newStart: null,
          create: {
            title: change.title,
            start: change.start,
            end: change.end,
            durationMinutes: change.durationMinutes,
            priority: change.priority,
            taskKind: change.taskKind,
          },
          reason: change.reason,
        };
      }
      return {
        ref: change.ref,
        kind: change.kind,
        taskId: change.taskId,
        newStart: change.kind === "move" ? change.newStart : null,
        create: null,
        reason: change.reason,
      };
    }),
    rejectedMessages: validation.rejected.map((r) => r.message),
    conflictCount: validation.conflictsAfter.length,
    baseRevision: validation.baseRevision,
    fromBriefing,
    isStale: false,
  };
}

export function proposalViewFromPersisted(proposal: AiProposal, isStale: boolean): ProposalView {
  return {
    proposalId: proposal.id,
    understood: proposal.understood,
    unresolved: proposal.unresolved,
    status: proposal.validationStatus,
    accepted: proposal.changes.map((change): ProposalChangeView => {
      if (change.type === "create") {
        const start = new Date(change.start);
        return {
          ref: change.ref,
          kind: "create",
          taskId: null,
          newStart: null,
          create: {
            title: change.title,
            start,
            end: new Date(start.getTime() + change.duration_minutes * 60_000),
            durationMinutes: change.duration_minutes,
            priority: change.priority,
            taskKind: change.kind,
          },
          reason: null,
        };
      }
      return {
        ref: change.ref,
        kind: change.type,
        taskId: change.task_id,
        newStart: change.type === "move" ? new Date(change.new_start) : null,
        create: null,
        reason: null,
      };
    }),
    rejectedMessages: proposal.rejected.map((r) => r.message),
    conflictCount: proposal.conflictsAfter.length,
    baseRevision: proposal.baseRevision,
    fromBriefing: proposal.briefingId !== null,
    isStale,
  };
}
