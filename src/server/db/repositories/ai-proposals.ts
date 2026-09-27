import "server-only";
import { toConfirmationChanges } from "@/domain/ai-planning";
import type {
  ConflictAfter,
  IntentSource,
  Rejection,
  ValidationResult,
} from "@/domain/ai-planning";
import {
  storedChangesSchema,
  storedConflictsSchema,
  storedRejectedSchema,
  storedUnresolvedSchema,
  type StoredChangeRow,
  type StoredConflict,
  type StoredRejection,
} from "@/lib/validation/ai-proposals";
import { AiConfirmationError, ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";
import type { Database } from "../database.types";
import { toConfirmChangeRow } from "./tasks";

type ProposalRow = Database["public"]["Tables"]["ai_proposals"]["Row"];

export type AiProposalStatus = "generated" | "confirmed" | "discarded";

export interface AiProposal {
  id: string;
  dayId: string;
  baseRevision: number;
  source: IntentSource;
  transcriptText: string;
  understood: string;
  unresolved: string[];
  changes: StoredChangeRow[];
  rejected: StoredRejection[];
  conflictsAfter: StoredConflict[];
  validationStatus: ValidationResult["status"];
  status: AiProposalStatus;
  createdAt: Date;
  confirmedAt: Date | null;
  appliedRevisionNumber: number | null;
}

/** `P0002` from any RPC in this file: not found, not the caller's, or not in the required
 *  state — deliberately not distinguished (see the migration). */
const NOT_AVAILABLE = "P0002";
const INVALID_PARAMETER = "22023";
const STALE_WRITE = "40001";
const SCHEDULE_CONFLICT = "23P01";
const NO_PROFILE_OR_DAY = "P0002";

/** Validates the three JSONB columns at the read boundary — see lib/validation/ai-proposals.ts.
 *  A row that fails this (which nothing in this app's own write path can produce) is treated as
 *  an external-service failure rather than silently trusted. */
function mapProposal(row: ProposalRow): AiProposal {
  const changes = storedChangesSchema.parse(row.changes);
  const rejected = storedRejectedSchema.parse(row.rejected);
  const conflictsAfter = storedConflictsSchema.parse(row.conflicts_after);
  const unresolved = storedUnresolvedSchema.parse(row.unresolved);
  return {
    id: row.id,
    dayId: row.day_id,
    baseRevision: row.base_revision,
    source: row.source,
    transcriptText: row.transcript_text,
    understood: row.understood,
    unresolved,
    changes,
    rejected,
    conflictsAfter,
    validationStatus: row.validation_status,
    status: row.status,
    createdAt: new Date(row.created_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
    appliedRevisionNumber: row.applied_revision_number,
  };
}

export interface CreateAiProposalInput {
  dayId: string;
  source: IntentSource;
  transcriptText: string;
  understood: string;
  unresolved: readonly string[];
  /** The full Phase 5.0 verdict this proposal was generated with. `accepted` becomes the
   *  stored `changes` (confirm wire shape, via the existing `toConfirmationChanges`); the rest
   *  is stored as-is, for display only. */
  validation: ValidationResult;
}

/**
 * The only way a proposal row is created (`create_ai_proposal`, Phase 5.5). Atomically
 * supersedes any earlier pending proposal for the same day — enforced in SQL, not here.
 */
export async function createAiProposal(
  supabase: SupabaseServerClient,
  input: CreateAiProposalInput,
): Promise<AiProposal> {
  const changes = toConfirmationChanges(input.validation.accepted).map(toConfirmChangeRow);
  const rejected: Rejection[] = [...input.validation.rejected];
  const conflictsAfter: ConflictAfter[] = [...input.validation.conflictsAfter];

  const { data, error } = await supabase.rpc("create_ai_proposal", {
    p_day_id: input.dayId,
    p_base_revision: input.validation.baseRevision,
    p_source: input.source,
    p_transcript_text: input.transcriptText,
    p_understood: input.understood,
    p_unresolved: [...input.unresolved],
    p_changes: changes,
    p_rejected: rejected,
    p_conflicts_after: conflictsAfter,
    p_validation_status: input.validation.status,
  });
  if (error) {
    if (error.code === NO_PROFILE_OR_DAY) {
      throw new ExternalServiceError("supabase", {
        message: "That planning day wasn't found.",
        cause: error,
      });
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return mapProposal(data);
}

/** Read-only: the day's current pending ("generated") proposal, or null. RLS scopes this to
 *  the caller; there is at most one per day (see the partial unique index). */
export async function findPendingProposal(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<AiProposal | null> {
  const { data, error } = await supabase
    .from("ai_proposals")
    .select("*")
    .eq("day_id", dayId)
    .eq("status", "generated")
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapProposal(data) : null;
}

/** Read-only: a specific proposal by id. RLS hides other users' rows, so a foreign or
 *  nonexistent id is simply null — never distinguishable from "not yours". */
export async function getAiProposalById(
  supabase: SupabaseServerClient,
  proposalId: string,
): Promise<AiProposal | null> {
  const { data, error } = await supabase
    .from("ai_proposals")
    .select("*")
    .eq("id", proposalId)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapProposal(data) : null;
}

/**
 * Confirms a PERSISTED proposal by id (`confirm_ai_proposal_by_id`, Phase 5.5) — the
 * replay-safe path. The RPC reads day/base_revision/changes from the stored row itself, not
 * from this call, and re-validates everything in SQL (Phase 5.3's `confirm_ai_proposal`,
 * unchanged, composed in the same transaction) before marking the row confirmed.
 */
export async function confirmAiProposalById(
  supabase: SupabaseServerClient,
  proposalId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("confirm_ai_proposal_by_id", {
    p_proposal_id: proposalId,
  });
  if (error) {
    if (error.code === STALE_WRITE)
      throw new AiConfirmationError("stale_revision", { cause: error });
    if (error.code === NOT_AVAILABLE)
      throw new AiConfirmationError("proposal_unavailable", { cause: error });
    if (error.code === SCHEDULE_CONFLICT)
      throw new AiConfirmationError("conflict", { cause: error });
    if (error.code === INVALID_PARAMETER)
      throw new AiConfirmationError("invalid_proposal", { cause: error });
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return data;
}

/** Discards a pending proposal (the review UI's Cancel). Idempotent and silent on a foreign,
 *  missing, or already-resolved id — see `discard_ai_proposal` for why. */
export async function discardAiProposal(
  supabase: SupabaseServerClient,
  proposalId: string,
): Promise<void> {
  const { error } = await supabase.rpc("discard_ai_proposal", { p_proposal_id: proposalId });
  if (error) throw new ExternalServiceError("supabase", { cause: error });
}
