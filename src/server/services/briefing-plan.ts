import "server-only";
import { isPlanDateAllowed } from "@/domain/days";
import { buildBriefingPlanningContext, validateProposal } from "@/domain/ai-planning";
import { briefingPlanInputSchema } from "@/lib/validation/ai-planning";
import { createAnthropicBriefingGenerator } from "@/server/ai/anthropic-briefing";
import type { BriefingPlanGenerator } from "@/server/ai/briefing-port";
import { generateParsedBriefingProposal } from "@/server/ai/generate-briefing";
import { requireUserForAction } from "@/server/auth/session";
import { createAiProposal } from "@/server/db/repositories/ai-proposals";
import { getLatestBriefingForDay } from "@/server/db/repositories/briefings";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { ValidationError } from "@/server/errors";
import { loadPlanningInputs, type AiProposalResult } from "./ai-planning";
import { todayLocalDate, viewDay } from "./day";

/** What a briefing proposal stores as its "request" when the user added no note of their own. The
 *  briefing itself is NOT copied: it is linked by id (briefings are append-only, so the link is an
 *  exact record) and stays in the user's own table. */
export const BRIEFING_REQUEST_MARKER = "Plan my day from my saved briefing";

export interface BriefingPlanDeps {
  /** Defaults to the Anthropic adapter; tests inject a fake through the same port. */
  generator?: BriefingPlanGenerator;
  now?: () => Date;
  signal?: AbortSignal;
}

/**
 * Phase 8 — turns the caller's SAVED briefing into a proposal of NEW tasks, validates it, and
 * persists the snapshot. Like `generateAiProposal`, the only write is that one proposal row
 * (`create_ai_proposal`); it never touches tasks, history or revisions, never confirms anything,
 * and never writes a notification. Applying is the user's explicit, separate confirmation.
 *
 *   authenticated user → {planningDate, optional note} (validated; nothing else is accepted)
 *   → server-resolved day (read-only) → the user's own latest briefing for that day
 *   → planning state under RLS → context (aliases, free windows, rules, briefing as DATA)
 *   → generator → Zod → validateProposal → persist → { proposalId, understood, ... }
 *
 * The browser supplies no briefing text, briefing id, day id, user id, timezone or clock: all of
 * them are resolved here. A provider failure throws a sanitized `AiError` BEFORE anything is
 * written. A proposal the validator refuses is persisted (status `invalid` / `partially_valid`)
 * so the review can say why — it creates no task and cannot be confirmed. One explicit click is
 * one call: nothing here loops, retries, or runs on its own.
 */
export async function generateBriefingPlan(
  rawInput: unknown,
  deps: BriefingPlanDeps = {},
): Promise<AiProposalResult> {
  const user = await requireUserForAction();
  const now = (deps.now ?? (() => new Date()))();

  const parsed = briefingPlanInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const input = parsed.data;

  const supabase = await createSupabaseServerClient();
  const clock = await todayLocalDate(supabase, user.id);
  if (!clock) {
    throw new ValidationError([
      { path: "timezone", message: "Still setting up your timezone — please try again." },
    ]);
  }
  if (!isPlanDateAllowed(input.planningDate, clock.todayLocal)) {
    throw new ValidationError([
      { path: "planningDate", message: "Pick a date from today up to a year ahead." },
    ]);
  }

  const day = await viewDay(supabase, user.id, input.planningDate);
  if (!day) {
    throw new ValidationError([
      { path: "planningDate", message: "There's nothing planned on that day yet." },
    ]);
  }

  const briefing = await getLatestBriefingForDay(supabase, user.id, day.id);
  if (!briefing) {
    throw new ValidationError([
      { path: "briefing", message: "Save your briefing first, then plan your day from it." },
    ]);
  }

  const { baseRevision, bounds, tasks } = await loadPlanningInputs(supabase, user.id, day);
  const { context, state } = buildBriefingPlanningContext({
    dayId: day.id,
    planningDate: day.localDate,
    timezone: day.timezone, // the day's frozen zone, not the profile's current one
    now,
    dayBounds: bounds,
    baseRevision,
    tasks,
    briefingText: briefing.rawText,
  });

  const note = input.note === "" ? null : input.note;
  const generator = deps.generator ?? createAnthropicBriefingGenerator();
  const proposal = await generateParsedBriefingProposal(generator, context, note, {
    signal: deps.signal,
  });
  const validation = validateProposal({ state, parsed: proposal });

  const persisted = await createAiProposal(supabase, {
    dayId: day.id,
    source: note === null ? "typed" : input.source,
    transcriptText: note ?? BRIEFING_REQUEST_MARKER,
    understood: proposal.proposal.understood,
    unresolved: proposal.proposal.unresolved,
    validation,
    briefingId: briefing.id,
  });

  return {
    proposalId: persisted.id,
    understood: proposal.proposal.understood,
    unresolved: proposal.proposal.unresolved,
    validation,
  };
}
