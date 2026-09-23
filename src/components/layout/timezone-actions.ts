"use server";

import { runAction, type ActionResult } from "@/server/errors";
import { syncTimezone } from "@/server/services/profile";

export async function syncTimezoneAction(timezone: unknown): Promise<ActionResult<null>> {
  return runAction(async () => {
    await syncTimezone(timezone);
    return null;
  });
}
