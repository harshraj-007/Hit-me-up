import "server-only";
import { timingSafeEqual } from "node:crypto";
import { getCronSecret } from "@/config/env.server";

/**
 * The authentication boundary for the system/cron path (Phase 6.2) — a sibling to
 * `requireUser`/`requireUserForAction`, but for a caller that has no user session at all.
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically once that env var is
 * configured; this checks the request against it.
 *
 * Deliberately indistinguishable from the outside whether `CRON_SECRET` is merely unset or the
 * caller supplied the wrong value — both are `false`, so the route always answers 401 either
 * way, never leaking "is this deployment configured yet" to an unauthenticated prober. A
 * constant-time comparison guards against a timing attack recovering the secret byte by byte.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = getCronSecret();
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;
  const [scheme, token] = header.split(" ", 2);
  if (scheme !== "Bearer" || !token) return false;

  const expected = Buffer.from(secret);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
