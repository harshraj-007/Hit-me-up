import { AppError } from "@/server/errors";

export type AiFailureReason =
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "rate_limited"
  | "provider_error"
  | "malformed_response";

const SAFE: Record<AiFailureReason, { message: string; status: number }> = {
  unavailable: { message: "AI planning isn't available right now.", status: 503 },
  timeout: { message: "The AI took too long to respond. Please try again.", status: 504 },
  cancelled: { message: "The request was cancelled.", status: 499 },
  rate_limited: { message: "The AI service is busy. Please try again in a moment.", status: 429 },
  provider_error: { message: "The AI service had a problem. Please try again.", status: 502 },
  malformed_response: {
    message: "The AI's response couldn't be used. Please try again.",
    status: 502,
  },
};

/**
 * Every AI failure the app can surface. The message is fixed, client-safe text; the provider's
 * own error is NEVER attached as `cause` (SDK errors carry request headers and response
 * bodies) — only a sanitized diagnostic, chosen by the adapter.
 */
export class AiError extends AppError {
  readonly code = "EXTERNAL_SERVICE_ERROR";
  readonly status: number;
  readonly reason: AiFailureReason;

  constructor(reason: AiFailureReason, diagnostic?: string) {
    super(SAFE[reason].message, diagnostic ? { cause: new Error(diagnostic) } : undefined);
    this.status = SAFE[reason].status;
    this.reason = reason;
  }
}
