import "server-only";
import { getAiConfig, type AiConfig } from "@/config/env.server";
import type { BriefingPlanningContext } from "@/domain/ai-planning";
import { logger } from "@/server/logging/logger";
import {
  AI_TIMEOUT_MS,
  classify,
  createDefaultClient,
  sanitizedDiagnostic,
  type AnthropicMessage,
  type AnthropicToolInputSchema,
  type MessagesClient,
} from "./anthropic";
import { AiError } from "./errors";
import type { BriefingPlanGenerator } from "./briefing-port";
import type { ProposeOptions } from "./port";
import {
  BRIEFING_INPUT_SCHEMA,
  BRIEFING_PROMPT_VERSION,
  BRIEFING_SYSTEM_PROMPT,
  BRIEFING_TOOL_DESCRIPTION,
  BRIEFING_TOOL_NAME,
  buildBriefingUserMessage,
} from "./briefing-prompt";

const MAX_OUTPUT_TOKENS = 3072;

export interface AnthropicBriefingDeps {
  config?: () => AiConfig | null;
  createClient?: (apiKey: string) => MessagesClient;
  timeoutMs?: number;
}

/**
 * The Anthropic implementation of `BriefingPlanGenerator`. Thin, like its siblings: one request
 * (static system prompt, delimited JSON-encoded data, one forced tool), ONE logical call (the SDK
 * may itself retry a 429/5xx within the overall budget), the tool's payload returned untouched as
 * `unknown`. It never parses, validates, persists or notifies. Logs carry no briefing, note or
 * task text — only the model, prompt version, latency and outcome.
 */
export function createAnthropicBriefingGenerator(
  deps: AnthropicBriefingDeps = {},
): BriefingPlanGenerator {
  const log = logger.child({ provider: "anthropic", feature: "briefing-plan" });
  const timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;

  return {
    async propose(
      context: BriefingPlanningContext,
      note: string | null,
      options: ProposeOptions = {},
    ): Promise<unknown> {
      const config = (deps.config ?? getAiConfig)();
      if (!config) throw new AiError("unavailable", "anthropic not configured");

      const client: MessagesClient = deps.createClient
        ? deps.createClient(config.apiKey)
        : createDefaultClient(config.apiKey);

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const started = Date.now();

      let response: AnthropicMessage;
      try {
        response = await client.messages.create(
          {
            model: config.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: BRIEFING_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildBriefingUserMessage(context, note) }],
            tools: [
              {
                name: BRIEFING_TOOL_NAME,
                description: BRIEFING_TOOL_DESCRIPTION,
                input_schema: BRIEFING_INPUT_SCHEMA as AnthropicToolInputSchema,
              },
            ],
            tool_choice: {
              type: "tool",
              name: BRIEFING_TOOL_NAME,
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
          templateVersion: BRIEFING_PROMPT_VERSION,
          latencyMs: Date.now() - started,
        });
        throw new AiError(reason, sanitizedDiagnostic(error));
      }

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const block = toolUses.length === 1 ? toolUses[0] : undefined;
      const malformed =
        !block || block.name !== BRIEFING_TOOL_NAME || response.stop_reason === "max_tokens";
      log.info("ai request completed", {
        model: config.model,
        templateVersion: BRIEFING_PROMPT_VERSION,
        latencyMs: Date.now() - started,
        stopReason: response.stop_reason,
        outcome: malformed ? "malformed" : "ok",
      });
      if (malformed) {
        throw new AiError(
          "malformed_response",
          "anthropic response had no usable briefing-plan tool call",
        );
      }
      return block.input;
    },
  };
}
