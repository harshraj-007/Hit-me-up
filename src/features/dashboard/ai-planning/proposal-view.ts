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

export interface ProposalChangeView {
  ref: string;
  kind: "move" | "unschedule";
  /** Local instant the task would move to; null for an unschedule. */
  newStart: Date | null;
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
  /** True only for a resumed proposal whose base revision no longer matches the day's current
   *  one — a freshly generated proposal is never stale at the instant it is shown. */
  isStale: boolean;
}

export function proposalViewFromGenerated(result: AiProposalResult): ProposalView {
  const { validation } = result;
  return {
    proposalId: result.proposalId,
    understood: result.understood,
    unresolved: result.unresolved,
    status: validation.status,
    accepted: validation.accepted.map((change) => ({
      ref: change.ref,
      kind: change.kind,
      newStart: change.kind === "move" ? change.newStart : null,
      reason: change.reason,
    })),
    rejectedMessages: validation.rejected.map((r) => r.message),
    conflictCount: validation.conflictsAfter.length,
    baseRevision: validation.baseRevision,
    isStale: false,
  };
}

export function proposalViewFromPersisted(proposal: AiProposal, isStale: boolean): ProposalView {
  return {
    proposalId: proposal.id,
    understood: proposal.understood,
    unresolved: proposal.unresolved,
    status: proposal.validationStatus,
    accepted: proposal.changes.map((change) => ({
      ref: change.ref,
      kind: change.type,
      newStart: change.type === "move" ? new Date(change.new_start) : null,
      reason: null,
    })),
    rejectedMessages: proposal.rejected.map((r) => r.message),
    conflictCount: proposal.conflictsAfter.length,
    baseRevision: proposal.baseRevision,
    isStale,
  };
}
