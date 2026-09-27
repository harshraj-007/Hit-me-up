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
import { getLatestRevisionNumber } from "@/server/db/repositories/plans";
import { listSpilloverTasks, listTasksForDay } from "@/server/db/repositories/tasks";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { NotFoundError, ValidationError } from "@/server/errors";
import { todayLocalDate, viewDay } from "./day";

export interface AiProposalResult {
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
 * Phase 5.2 — generates and validates an AI proposal. READ-ONLY: nothing in here writes to the
 * database (no `ensure_day`, no RPC, no insert/update), stores a proposal, or applies anything.
 *
 *   authenticated user → UserIntent (validated, horizon-checked, server-stamped)
 *   → planning day + tasks + spillover + base revision, all read under the caller's RLS
 *   → PlanningContext (aliases, allow-list) → ProposalGenerator → Zod → validateProposal
 *   → ValidationResult
 *
 * `rawInput` is untrusted. Identity comes only from the verified session. A provider failure
 * surfaces as an `AiError` (sanitized); a proposal the validator refuses is NOT an error — it is
 * a `ValidationResult` with status `invalid` / `partially_valid`.
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

  return {
    understood: proposal.proposal.understood,
    unresolved: proposal.proposal.unresolved,
    validation: validateProposal({ state, parsed: proposal }),
  };
}
