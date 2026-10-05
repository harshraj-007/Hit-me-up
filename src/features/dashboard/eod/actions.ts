"use server";

import { runAction, type ActionResult } from "@/server/errors";
import { generateEodReport, type GenerateEodResult } from "@/server/services/eod-report";

/**
 * Thin Server Action wrapper, matching every other feature's actions.ts: no logic lives here. It
 * deliberately takes NO input at all — the user, the planning day and the date are all resolved
 * server-side from the verified session, so there is nothing for a browser to name (and nothing
 * for a forged request to point at a different user's day, a future day, or a past one).
 */
export async function generateEodReportAction(): Promise<ActionResult<GenerateEodResult>> {
  return runAction(() => generateEodReport());
}
