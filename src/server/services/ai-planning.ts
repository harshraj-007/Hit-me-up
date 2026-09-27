import "server-only";
import { addDays, dayBoundsUtc } from "@/domain/days";
import {
  buildPlanningContext,
  validateProposal,
  type ValidationResult,
} from "@/domain/ai-planning";
import type { Task } from "@/domain/tasks";
import { parseUserIntent } from "@/lib/validation/ai-planning";
import { createAnthropicGenerator } from "@/server/ai/anthropic";
import { generateParsedProposal } from "@/server/ai/generate";
import type { ProposalGenerator } from "@/server/ai/port";
import { requireUserForAction } from "@/server/auth/session";
import {
  createAiProposal,
  findPendingProposal,
  type AiProposal,
} from "@/server/db/repositories/ai-proposals";
import { getLatestRevisionNumber } from "@/server/db/repositories/plans";
import { listSpilloverTasks, listTasksForDay } from "@/server/db/repositories/tasks";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { NotFoundError, ValidationError } from "@/server/errors";
import { todayLocalDate, viewDay } from "./day";

export interface AiProposalResult {
  /** The persisted proposal's id (Phase 5.5) — what a later confirm/discard call names.
   *  Nothing about confirming it is implied by generating it; see ai-confirmation.ts. */
  proposalId: string;
  /** The model's own words, for display only ("I understood…"). Untrusted text. */
  understood: string;
  /** Requests the model could not turn into a supported change. Untrusted text. */
  unresolved: string[];
  /** The deterministic verdict — the only thing a later confirmation step may rely on. */
  validation: ValidationResult;
}

export interface AiProposalDeps {
  /** Defaults to the Anthropic adapter; tests inject a fake through the same port. */
  generator?: ProposalGenerator;
  now?: () => Date;
  signal?: AbortSignal;
}

/**
 * Phase 5.2/5.5 — generates, validates, and persists an AI proposal. The only write this
 * function performs is that one persisted snapshot (`create_ai_proposal`, Phase 5.5) — it
 * never touches `tasks`/`task_history`/`plan_revisions`, calls `ensure_day`, or applies
 * anything to the schedule.
 *
 *   authenticated user → UserIntent (validated, horizon-checked, server-stamped)
 *   → planning day + tasks + spillover + base revision, all read under the caller's RLS
 *   → PlanningContext (aliases, allow-list) → ProposalGenerator → Zod → validateProposal
 *   → ValidationResult → persist an immutable snapshot → { proposalId, understood, ... }
 *
 * `rawInput` is untrusted. Identity comes only from the verified session. A provider failure
 * surfaces as an `AiError` (sanitized); a proposal the validator refuses is NOT an error — it is
 * persisted and returned with status `invalid` / `partially_valid`, exactly like a `valid` one,
 * so the user can see WHY nothing (or only part) was accepted. Persisting happens only AFTER
 * validation — an unvalidated proposal is never written, and if persistence itself fails, this
 * throws rather than returning a proposal the caller could not actually resume later.
 */
export async function generateAiProposal(
  rawInput: unknown,
  deps: AiProposalDeps = {},
): Promise<AiProposalResult> {
  const user = await requireUserForAction();
  const now = (deps.now ?? (() => new Date()))();
  const supabase = await createSupabaseServerClient();

  const clock = await todayLocalDate(supabase, user.id);
  if (!clock) {
    throw new ValidationError([
      { path: "timezone", message: "Still setting up your timezone — please try again." },
    ]);
  }

  const parsed = parseUserIntent(rawInput, { submittedAt: now, todayLocal: clock.todayLocal });
  if (!parsed.ok) throw new ValidationError(parsed.issues);
  const intent = parsed.intent;

  // Read-only: looking at a day never creates it. No row means nothing is planned there.
  const day = await viewDay(supabase, user.id, intent.planningDate);
  if (!day) {
    throw new ValidationError([
      { path: "planningDate", message: "There's nothing planned on that day yet." },
    ]);
  }

  // The revision is read BEFORE the tasks. If the plan changes between the two reads, the tasks
  // are newer than `baseRevision`, so a later confirm (which compares it) fails as stale. Read
  // the other way round, it could accept a proposal computed from outdated tasks.
  const baseRevision = await getLatestRevisionNumber(supabase, day.id);
  if (baseRevision === null) throw new NotFoundError({ message: "That day's plan wasn't found." });

  const previous = await viewDay(supabase, user.id, addDays(day.localDate, -1));
  const bounds = dayBoundsUtc(day.localDate, day.timezone);
  const [own, spill] = await Promise.all([
    listTasksForDay(supabase, day.id),
    previous ? listSpilloverTasks(supabase, previous.id, bounds.start) : Promise.resolve([]),
  ]);

  // RLS already scopes these reads to the caller. This is a second, independent check: a row
  // that is not the caller's, or not from the expected day, never reaches the context.
  const tasks: Task[] = [
    ...own.filter((t) => t.userId === user.id && t.dayId === day.id),
    ...spill.filter((t) => t.userId === user.id && previous !== null && t.dayId === previous.id),
  ];

  const { context, state } = buildPlanningContext({
    dayId: day.id,
    planningDate: day.localDate,
    timezone: day.timezone, // the day's frozen zone, not the profile's current one
    now,
    dayBounds: bounds,
    baseRevision,
    tasks,
  });

  const generator = deps.generator ?? createAnthropicGenerator();
  const proposal = await generateParsedProposal(generator, context, intent, {
    signal: deps.signal,
  });
  const validation = validateProposal({ state, parsed: proposal });

  const persisted = await createAiProposal(supabase, {
    dayId: day.id,
    source: intent.source,
    transcriptText: intent.text,
    understood: proposal.proposal.understood,
    unresolved: proposal.proposal.unresolved,
    validation,
  });

  return {
    proposalId: persisted.id,
    understood: proposal.proposal.understood,
    unresolved: proposal.proposal.unresolved,
    validation,
  };
}

export interface PendingAiProposal {
  proposal: AiProposal;
  /** Whether `proposal.baseRevision` no longer matches the day's CURRENT plan revision — a
   *  live comparison, recomputed on every read, never itself stored (see the migration for
   *  why). Decoration only: `confirmPersistedAiProposal` independently re-checks the same
   *  thing in SQL regardless of what this says. */
  isStale: boolean;
}

/**
 * Read-only: the day's pending (unconfirmed) proposal, if any, with no AI call — a persisted
 * proposal must be enough to reconstruct the review UI after a refresh or navigation on its
 * own. Used both by the Today page (server-rendered, so a resumed proposal shows on first
 * paint) and, if ever needed, directly.
 */
export async function loadPendingAiProposal(
  planningDate: string,
): Promise<PendingAiProposal | null> {
  const user = await requireUserForAction();
  const supabase = await createSupabaseServerClient();

  const day = await viewDay(supabase, user.id, planningDate);
  if (!day) return null;

  const proposal = await findPendingProposal(supabase, day.id);
  if (!proposal) return null;

  const currentRevision = await getLatestRevisionNumber(supabase, day.id);
  const isStale = currentRevision === null || currentRevision !== proposal.baseRevision;
  return { proposal, isStale };
}
