import "server-only";
import { revalidatePath } from "next/cache";
import { requireUserForAction } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/db/supabase-server";
import { insertBriefing, type Briefing } from "@/server/db/repositories/briefings";
import { createBriefingInputSchema } from "@/lib/validation/briefing";
import { resolveCurrentDay } from "./day";

/** Saves a new briefing for the caller's current day. Briefings are append-only (see the
 *  migration) — this always inserts a fresh row rather than editing a previous one. */
export async function saveBriefingForToday(rawInput: unknown): Promise<Briefing> {
  const user = await requireUserForAction();
  const input = createBriefingInputSchema.parse(rawInput);

  const supabase = await createSupabaseServerClient();
  const day = await resolveCurrentDay(supabase, user.id);
  const briefing = await insertBriefing(supabase, user.id, day.id, input.rawText);

  revalidatePath("/today");
  return briefing;
}
