import "server-only";
import { NextResponse } from "next/server";
import { logger } from "@/server/logging/logger";
import { ValidationError, type AppError } from "./app-error";
import { toAppError } from "./normalize";

export interface ErrorBody {
  error: {
    code: AppError["code"];
    message: string;
    requestId: string;
    issues?: { path: string; message: string }[];
  };
}

/** Logs the failure with full server-side detail and returns a client-safe JSON response. */
export function errorResponse(
  error: unknown,
  requestId: string = crypto.randomUUID(),
): NextResponse<ErrorBody> {
  const appError = toAppError(error);
  const log = logger.child({ requestId });
  if (appError.status >= 500) log.error("request failed", { err: appError, code: appError.code });
  else log.warn("request rejected", { code: appError.code, message: appError.message });

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId,
      ...(appError instanceof ValidationError && appError.issues.length
        ? { issues: appError.issues }
        : {}),
    },
  };
  return NextResponse.json(body, {
    status: appError.status,
    headers: { "Cache-Control": "no-store" },
  });
}

type Handler<Ctx> = (request: Request, ctx: Ctx) => Promise<Response>;

/** Wraps a route handler so any thrown error becomes a consistent, safe JSON response. */
export function withErrorHandling<Ctx = unknown>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (request, ctx) => {
    try {
      return await handler(request, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
