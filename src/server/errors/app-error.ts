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
