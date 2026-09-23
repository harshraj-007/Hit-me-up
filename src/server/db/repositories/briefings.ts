import "server-only";
import { ExternalServiceError } from "@/server/errors";
import type { SupabaseServerClient } from "../supabase-server";

export interface Briefing {
  id: string;
  rawText: string;
  createdAt: Date;
}

function mapBriefing(row: { id: string; raw_text: string; created_at: string }): Briefing {
  return { id: row.id, rawText: row.raw_text, createdAt: new Date(row.created_at) };
}

/** The most recent briefing for a day, or null if the user hasn't written one yet. */
export async function getLatestBriefing(
  supabase: SupabaseServerClient,
  dayId: string,
): Promise<Briefing | null> {
  const { data, error } = await supabase
    .from("briefings")
    .select("id, raw_text, created_at")
    .eq("day_id", dayId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return data ? mapBriefing(data) : null;
}

/** Briefings are append-only (see the migration) — this always inserts a new row. */
export async function insertBriefing(
  supabase: SupabaseServerClient,
  userId: string,
  dayId: string,
  rawText: string,
): Promise<Briefing> {
  const { data, error } = await supabase
    .from("briefings")
    .insert({ user_id: userId, day_id: dayId, raw_text: rawText })
    .select("id, raw_text, created_at")
    .single();

  if (error) throw new ExternalServiceError("supabase", { cause: error });
  return mapBriefing(data);
}
