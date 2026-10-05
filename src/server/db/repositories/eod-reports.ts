import "server-only";
import type { EodReport } from "@/domain/eod";
import { storedEodFactsSchema, storedEodInterpretationSchema } from "@/lib/validation/eod";
import { ExternalServiceError, ValidationError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";
import type { Database } from "../database.types";

type ReportRow = Database["public"]["Tables"]["eod_reports"]["Row"];

/** `22023`: malformed input, or a day that has not started. `54000`: the per-day report cap.
 *  `P0002`: the day is not the caller's / does not exist (deliberately indistinguishable). */
const INVALID_PARAMETER = "22023";
const LIMIT_EXCEEDED = "54000";
const NOT_FOUND = "P0002";

/** Validates the two jsonb columns at the read boundary. A row that fails (which nothing in this
 *  app's own write path can produce) is an external-service failure, never silently trusted. */
function mapReport(row: ReportRow): EodReport {
  return {
    id: row.id,
    dayId: row.day_id,
    facts: storedEodFactsSchema.parse(row.facts),
    interpretation: storedEodInterpretationSchema.parse(row.interpretation),
    promptVersion: row.prompt_version,
    stateFingerprint: row.state_fingerprint,
    createdAt: new Date(row.created_at),
  };
}

export interface CreateEodReportInput {
  dayId: string;
  stateFingerprint: string;
  promptVersion: string;
  facts: EodReport["facts"];
  interpretation: EodReport["interpretation"];
}

/**
 * The only way a report row is created (`create_eod_report`, Phase 7). Idempotent in SQL: a
 * replay of the same day-state returns the existing report and writes nothing, and the RPC itself
 * enforces day ownership, that the day has started, and that the facts describe that very day.
 */
export async function createEodReport(
  supabase: SupabaseServerClient,
  input: CreateEodReportInput,
): Promise<EodReport> {
  const { data, error } = await supabase.rpc("create_eod_report", {
    p_day_id: input.dayId,
    p_state_fingerprint: input.stateFingerprint,
    p_prompt_version: input.promptVersion,
    p_facts: input.facts,
    p_interpretation: input.interpretation,
  });
  if (error) {
    if (error.code === LIMIT_EXCEEDED) {
      throw new ValidationError(
        [{ path: "report", message: "You've reviewed this day as often as is useful." }],
        { cause: error },
      );
    }
    if (error.code === INVALID_PARAMETER) {
      throw new ValidationError([{ path: "report", message: "That day can't be reviewed yet." }], {
        cause: error,
      });
    }
    if (error.code === NOT_FOUND) {
      throw new ExternalServiceError("supabase", {
        message: "That planning day wasn't found.",
        cause: error,
      });
    }
    throw new ExternalServiceError("supabase", { cause: error });
  }
  return mapReport(data);
}

/** Read-only: the day's newest report, or null. RLS scopes it to the caller. */
export async function findLatestEodReport(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<EodReport | null> {
  const { data, error } = await supabase
    .from("eod_reports")
    .select("*")
    .eq("day_id", dayId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapReport(data) : null;
}

/** Read-only: the report already written for this exact day-state, or null — what lets a repeat
 *  request skip the model call entirely. */
export async function findEodReportForState(
  supabase: SupabaseServerClient,
  dayId: string,
  stateFingerprint: string,
): Promise<EodReport | null> {
  const { data, error } = await supabase
    .from("eod_reports")
    .select("*")
    .eq("day_id", dayId)
    .eq("state_fingerprint", stateFingerprint)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapReport(data) : null;
}
