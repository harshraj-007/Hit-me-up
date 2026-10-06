export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "EXTERNAL_SERVICE_ERROR"
  | "RATE_LIMITED"
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

/** A short, human wait ("a minute", "about 12 minutes", "about 3 hours") — rounded UP so the user is
 *  never told to come back before they can. Deliberately says nothing about the limit itself. */
export function describeWait(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
  if (s <= 60) return "a minute";
  if (s < 3600) return `about ${Math.ceil(s / 60)} minutes`;
  const hours = Math.ceil(s / 3600);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

/**
 * The caller has used their share of the AI budget for now (Phase 9, `reserve_ai_call`). Distinct
 * from the provider's own 429 (`AiError` reason `rate_limited` — "the AI service is busy"): this one
 * is about THIS user and says so. The message is fixed, client-safe text; it carries a rounded wait
 * and nothing about the thresholds, the counts, which window tripped, or the database.
 */
export class RateLimitError extends AppError {
  readonly code = "RATE_LIMITED";
  readonly status = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, init: AppErrorInit = {}) {
    super(
      init.message ??
        `You've used your AI allowance for now. Try again in ${describeWait(retryAfterSeconds)}.`,
      {
        cause: init.cause,
      },
    );
    this.retryAfterSeconds = retryAfterSeconds;
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
 *
 * `proposal_unavailable` (Phase 5.5): the PROPOSAL itself — not a task inside it — is not
 * confirmable right now (missing, not the caller's, already confirmed, or discarded). It is
 * deliberately not distinguished from `task_ineligible` at the SQLSTATE level either (both are
 * P0002 from `confirm_ai_proposal_by_id`, on purpose — see the migration), but gets its own
 * reason/message because the right recovery reads differently ("this plan was already handled"
 * vs. "a task in it changed") even though the server can't always tell which happened.
 */
export type AiConfirmationFailureReason =
  "stale_revision" | "task_ineligible" | "conflict" | "invalid_proposal" | "proposal_unavailable";

const AI_CONFIRMATION_MESSAGES: Record<AiConfirmationFailureReason, string> = {
  stale_revision:
    "Your schedule changed since this proposal was generated. Please review a fresh one.",
  task_ineligible: "One or more tasks in this proposal are no longer available to change.",
  conflict: "Applying these changes would create a scheduling conflict.",
  invalid_proposal: "This proposal couldn't be applied.",
  proposal_unavailable: "This plan is no longer available to apply. Please review a fresh one.",
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
