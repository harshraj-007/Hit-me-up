"use server";

import { runAction, type ActionResult } from "@/server/errors";
import {
  registerPushSubscription,
  revokePushSubscription,
} from "@/server/services/push-subscriptions";

/**
 * Thin Server Action wrappers, matching every other feature's actions.ts: no logic lives here,
 * only the parse-and-persist boundary the client hook needs.
 */

export async function registerPushSubscriptionAction(input: unknown): Promise<ActionResult<void>> {
  return runAction(() => registerPushSubscription(input));
}

export async function revokePushSubscriptionAction(input: unknown): Promise<ActionResult<void>> {
  return runAction(() => revokePushSubscription(input));
}
