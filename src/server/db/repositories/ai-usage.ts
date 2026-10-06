import "server-only";
import { z } from "zod";
import { AuthenticationError, ExternalServiceError, RateLimitError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

/**
 * The model-calling features that draw on the ONE shared per-user AI budget. These names are the
 * only values `reserve_ai_call` accepts (and the table's CHECK constraint stores).
 */
export type AiFeature = "plan" | "briefing_plan" | "eod_review";

/** `42501`: no authenticated user. Anything else unexpected is an infrastructure failure. */
const NOT_AUTHENTICATED = "42501";

/** What `reserve_ai_call` returns. Strict: an answer that is neither a clean allow nor a clean
 *  refusal is not trusted as an allow. */
const reservationSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }),
  z.strictObject({
    allowed: z.literal(false),
    window: z.enum(["hour", "day"]),
    retry_after_seconds: z.number().int().positive(),
  }),
]);

/**
 * Reserves one model call from the caller's shared AI budget (`reserve_ai_call`, Phase 9) — call
 * this BEFORE building a prompt or calling the provider, and make that call only if this resolves.
 *
 *  - Allowed → resolves. The reservation is recorded and is NEVER refunded, even if the provider
 *    then fails: the call reached (and may have been billed by) the provider.
 *  - Over budget → throws `RateLimitError` (HTTP-429-equivalent, safe message, rounded wait).
 *  - Anything else — a database error, no session, an answer that doesn't parse — throws too. The
 *    limiter FAILS CLOSED: if the budget can't be checked, no model call is made.
 *
 * The limits themselves live in the database (`ai_usage_limits`), never here: this function sends
 * only the feature name, so nothing the caller does can widen its own budget.
 */
export async function reserveAiCall(
  supabase: SupabaseServerClient,
  feature: AiFeature,
): Promise<void> {
  const { data, error } = await supabase.rpc("reserve_ai_call", { p_feature: feature });
  if (error) {
    if (error.code === NOT_AUTHENTICATED) {
      throw new AuthenticationError({
        message: "Your session has expired. Please sign in again.",
        cause: error,
      });
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  const parsed = reservationSchema.safeParse(data);
  if (!parsed.success) {
    throw new ExternalServiceError("supabase", {
      message: "The AI usage check returned an unusable answer.",
      cause: parsed.error,
    });
  }
  if (!parsed.data.allowed) throw new RateLimitError(parsed.data.retry_after_seconds);
}
