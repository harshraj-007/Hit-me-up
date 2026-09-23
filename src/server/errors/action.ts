import "server-only";
import { logger } from "@/server/logging/logger";
import { toAppError } from "./normalize";
import { ValidationError, type AppError, type FieldIssue } from "./app-error";

export interface ActionErrorPayload {
  code: AppError["code"];
  message: string;
  requestId: string;
  issues?: FieldIssue[];
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionErrorPayload };

/**
 * The Server Action counterpart of `withErrorHandling`/`errorResponse` (src/server/errors/route.ts):
 * same classification, logging and redaction, just returned as data instead of a
 * NextResponse, since a Server Action's thrown errors don't reach the browser as a normal
 * HTTP response the way a route handler's do.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const appError = toAppError(error);
    const requestId = crypto.randomUUID();
    const log = logger.child({ requestId });
    if (appError.status >= 500) log.error("action failed", { err: appError, code: appError.code });
    else log.warn("action rejected", { code: appError.code, message: appError.message });

    return {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        requestId,
        ...(appError instanceof ValidationError && appError.issues.length
          ? { issues: appError.issues }
          : {}),
      },
    };
  }
}
