import "server-only";
import { getAiConfig, type AiConfig } from "@/config/env.server";
import type { EodFacts } from "@/domain/eod";
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
import type { EodInterpreter, InterpretOptions } from "./eod-port";
import {
  EOD_INPUT_SCHEMA,
  EOD_PROMPT_VERSION,
  EOD_SYSTEM_PROMPT,
  EOD_TOOL_DESCRIPTION,
  EOD_TOOL_NAME,
  buildEodUserMessage,
} from "./eod-prompt";

const MAX_OUTPUT_TOKENS = 1024;

export interface AnthropicEodDeps {
  /** Overrides configuration lookup (tests). */
  config?: () => AiConfig | null;
  /** Overrides client construction (tests). */
  createClient?: (apiKey: string) => MessagesClient;
  timeoutMs?: number;
}

/**
 * The Anthropic implementation of `EodInterpreter`. Thin on purpose, like the planning adapter it
 * sits beside (and reuses the failure classification of): one request (static system prompt,
 * delimited data, one forced tool that can only emit interpretation text), ONE logical call (the SDK may itself retry a 429/5xx within the overall budget), and the
 * tool's payload handed back untouched as `unknown`. It does not parse, validate, or persist.
 */
export function createAnthropicEodInterpreter(deps: AnthropicEodDeps = {}): EodInterpreter {
  const log = logger.child({ provider: "anthropic", feature: "eod" });
  const timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;

  return {
    async interpret(facts: EodFacts, options: InterpretOptions = {}): Promise<unknown> {
      const config = (deps.config ?? getAiConfig)();
      if (!config) throw new AiError("unavailable", "anthropic not configured", "review");

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
            system: EOD_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildEodUserMessage(facts) }],
            tools: [
              {
                name: EOD_TOOL_NAME,
                description: EOD_TOOL_DESCRIPTION,
                input_schema: EOD_INPUT_SCHEMA as AnthropicToolInputSchema,
              },
            ],
            tool_choice: { type: "tool", name: EOD_TOOL_NAME, disable_parallel_tool_use: true },
          },
          { signal, timeout: timeoutMs },
        );
      } catch (error) {
        const reason = classify(error, timeout.aborted, options.signal?.aborted === true);
        log.warn("ai request failed", {
          reason,
          model: config.model,
          templateVersion: EOD_PROMPT_VERSION,
          latencyMs: Date.now() - started,
        });
        throw new AiError(reason, sanitizedDiagnostic(error), "review");
      }

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const block = toolUses.length === 1 ? toolUses[0] : undefined;
      const malformed =
        !block || block.name !== EOD_TOOL_NAME || response.stop_reason === "max_tokens";
      log.info("ai request completed", {
        model: config.model,
        templateVersion: EOD_PROMPT_VERSION,
        latencyMs: Date.now() - started,
        stopReason: response.stop_reason,
        outcome: malformed ? "malformed" : "ok",
      });
      if (malformed) {
        throw new AiError(
          "malformed_response",
          "anthropic response had no usable interpretation tool call",
          "review",
        );
      }
      return block.input;
    },
  };
}
