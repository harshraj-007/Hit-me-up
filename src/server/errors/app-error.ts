export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "EXTERNAL_SERVICE_ERROR"
  | "INTERNAL_ERROR";

export interface FieldIssue {
  path: string;
  message: string;
}

interface AppErrorInit {
  message?: string;
  cause?: unknown;
}

/**
 * Base class for expected, classified failures. `message` is always safe to show to clients;
 * internal detail belongs in `cause`, which is logged but never serialized into responses.
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly status = 400;
  readonly issues: FieldIssue[];

  constructor(issues: FieldIssue[] = [], init: AppErrorInit = {}) {
    super(init.message ?? "The request was invalid.", { cause: init.cause });
    this.issues = issues;
  }
}

export class AuthenticationError extends AppError {
  readonly code = "UNAUTHENTICATED";
  readonly status = 401;

  constructor(init: AppErrorInit = {}) {
    super(init.message ?? "Authentication is required.", { cause: init.cause });
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly status = 404;

  constructor(init: AppErrorInit = {}) {
    super(init.message ?? "The requested resource was not found.", { cause: init.cause });
  }
}

export class ExternalServiceError extends AppError {
  readonly code = "EXTERNAL_SERVICE_ERROR";
  readonly status = 502;
  readonly service: string;

  constructor(service: string, init: AppErrorInit = {}) {
    super(init.message ?? "A required upstream service failed.", { cause: init.cause });
    this.service = service;
  }
}

export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR";
  readonly status = 500;

  constructor(init: AppErrorInit = {}) {
    super(init.message ?? "Something went wrong.", { cause: init.cause });
  }
}

/**
 * A human-confirmed AI proposal was rejected by the database's own re-validation
 * (`confirm_ai_proposal`, Phase 5.3) — never by trusting the proposal that was shown to the
 * user. `reason` is a small, stable discriminator for the caller (mirrors `AiError.reason` in
 * `server/ai/errors.ts`), deliberately coarser than the RPC's own SQLSTATEs: a missing task, a
 * foreign one, a locked one and a resolved one are all `task_ineligible`, so a guessed or
 * copied task id is indistinguishable from one that never existed — nothing about another
 * user's data is ever revealed. See the migration for the full SQLSTATE → reason mapping.
 */
export type AiConfirmationFailureReason =
  "stale_revision" | "task_ineligible" | "conflict" | "invalid_proposal";

const AI_CONFIRMATION_MESSAGES: Record<AiConfirmationFailureReason, string> = {
  stale_revision:
    "Your schedule changed since this proposal was generated. Please review a fresh one.",
  task_ineligible: "One or more tasks in this proposal are no longer available to change.",
  conflict: "Applying these changes would create a scheduling conflict.",
  invalid_proposal: "This proposal couldn't be applied.",
};

export class AiConfirmationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly status = 409;
  readonly reason: AiConfirmationFailureReason;

  constructor(reason: AiConfirmationFailureReason, init: AppErrorInit = {}) {
    super(init.message ?? AI_CONFIRMATION_MESSAGES[reason], { cause: init.cause });
    this.reason = reason;
  }
}
