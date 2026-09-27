import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getAiConfig, type AiConfig } from "@/config/env.server";
import type { PlanningContext, UserIntent } from "@/domain/ai-planning";
import { logger } from "@/server/logging/logger";
import { AiError, type AiFailureReason } from "./errors";
import type { ProposalGenerator, ProposeOptions } from "./port";
import {
  PROMPT_VERSION,
  PROPOSAL_INPUT_SCHEMA,
  PROPOSAL_TOOL_DESCRIPTION,
  PROPOSAL_TOOL_NAME,
  SYSTEM_PROMPT,
  buildUserMessage,
} from "./prompt";

/** Overall budget for one proposal, including any SDK-level retries. */
export const AI_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 2048;

/** The one slice of the SDK this adapter uses; tests supply a stand-in. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Anthropic.Message>;
  };
}

export interface AnthropicGeneratorDeps {
  /** Overrides configuration lookup (tests). */
  config?: () => AiConfig | null;
  /** Overrides client construction (tests). */
  createClient?: (apiKey: string) => MessagesClient;
  timeoutMs?: number;
}

/** Maps an SDK failure to a fixed category WITHOUT forwarding any of its content. */
function classify(error: unknown, timedOut: boolean, cancelled: boolean): AiFailureReason {
  if (timedOut) return "timeout";
  if (cancelled) return "cancelled";
  const e = error as { name?: unknown; status?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (name === "APIConnectionTimeoutError") return "timeout";
  if (name === "APIUserAbortError") return "cancelled";
  if (status === 401 || status === 403) return "unavailable"; // bad credentials: a config problem
  if (status === 429) return "rate_limited";
  return "provider_error";
}

function sanitizedDiagnostic(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const name = (error as { name?: unknown } | null)?.name;
  return `anthropic ${typeof name === "string" ? name : "error"}${
    typeof status === "number" ? ` status=${status}` : ""
  }`;
}

/**
 * The Anthropic implementation of `ProposalGenerator`. Thin on purpose: it builds one request
 * (static system prompt, delimited data, one forced tool that can only emit proposal data),
 * makes ONE call, and hands the tool's payload back untouched as `unknown`. It does not parse,
 * validate, authorize, or persist — the Zod parser and the domain validator do that next.
 */
export function createAnthropicGenerator(deps: AnthropicGeneratorDeps = {}): ProposalGenerator {
  const log = logger.child({ provider: "anthropic" });
  const timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;

  return {
    async propose(
      context: PlanningContext,
      intent: UserIntent,
      options: ProposeOptions = {},
    ): Promise<unknown> {
      const config = (deps.config ?? getAiConfig)();
      if (!config) throw new AiError("unavailable", "anthropic not configured");

      const client: MessagesClient = deps.createClient
        ? deps.createClient(config.apiKey)
        : new Anthropic({ apiKey: config.apiKey });

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const started = Date.now();

      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model: config.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildUserMessage(context, intent) }],
            tools: [
              {
                name: PROPOSAL_TOOL_NAME,
                description: PROPOSAL_TOOL_DESCRIPTION,
                input_schema: PROPOSAL_INPUT_SCHEMA as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: {
              type: "tool",
              name: PROPOSAL_TOOL_NAME,
              disable_parallel_tool_use: true,
            },
          },
          { signal, timeout: timeoutMs },
        );
      } catch (error) {
        const reason = classify(error, timeout.aborted, options.signal?.aborted === true);
        log.warn("ai request failed", {
          reason,
          model: config.model,
          templateVersion: PROMPT_VERSION,
          latencyMs: Date.now() - started,
        });
        throw new AiError(reason, sanitizedDiagnostic(error));
      }

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const block = toolUses.length === 1 ? toolUses[0] : undefined;
      const malformed =
        !block || block.name !== PROPOSAL_TOOL_NAME || response.stop_reason === "max_tokens";
      log.info("ai request completed", {
        model: config.model,
        templateVersion: PROMPT_VERSION,
        latencyMs: Date.now() - started,
        stopReason: response.stop_reason,
        outcome: malformed ? "malformed" : "ok",
      });
      if (malformed) {
        throw new AiError(
          "malformed_response",
          "anthropic response had no usable proposal tool call",
        );
      }
      return block.input;
    },
  };
}
