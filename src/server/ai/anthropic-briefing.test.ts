import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBriefingPlanningContext, type BriefingPlanningContext } from "@/domain/ai-planning";
import { dayBoundsUtc } from "@/domain/days";
import {
  at,
  DAY_ID,
  makeTask,
  NOW,
  PLANNING_DATE,
  TZ,
} from "../../../tests/support/ai-planning-fixtures";
import { type MessagesClient } from "./anthropic";
import { createAnthropicBriefingGenerator } from "./anthropic-briefing";
import { BRIEFING_SYSTEM_PROMPT, BRIEFING_TOOL_NAME } from "./briefing-prompt";
import { AiError } from "./errors";

const API_KEY = "sk-ant-api03-TOP-SECRET-KEY-123";
const BRIEFING = "Confidential: renegotiate the Acme contract, gym at 6pm";
const TITLE = "Quarterly tax filing for Alice";
const config = () => ({ apiKey: API_KEY, model: "test-model" });
const { context } = buildBriefingPlanningContext({
  dayId: DAY_ID,
  planningDate: PLANNING_DATE,
  timezone: TZ,
  now: NOW,
  dayBounds: dayBoundsUtc(PLANNING_DATE, TZ),
  baseRevision: 1,
  tasks: [makeTask({ title: TITLE, start: at(14), end: at(15) })],
  briefingText: BRIEFING,
}) as { context: BriefingPlanningContext };

const PAYLOAD = {
  understood: "Plan the contract work and gym.",
  changes: [
    {
      kind: "create",
      title: "Acme contract",
      start: "2026-10-01T10:00",
      durationMinutes: 60,
      priority: "high",
      taskKind: "flexible",
      timeStated: false,
      reason: "Morning gap.",
    },
  ],
  unresolved: [],
};
const message = (content: unknown[], stop_reason = "tool_use") =>
  ({
    id: "m",
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as never;
const toolUse = (input: unknown, name = BRIEFING_TOOL_NAME) => ({
  type: "tool_use",
  id: "tu_1",
  name,
  input,
});
function fakeClient(impl: MessagesClient["messages"]["create"]) {
  const create = vi.fn(impl);
  return { create, client: { messages: { create } } as MessagesClient };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  vi.stubEnv("LOG_LEVEL", "debug");
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation(
      (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
    );
  }
});
afterEach(() => vi.restoreAllMocks());

const generator = (client: MessagesClient, extra = {}) =>
  createAnthropicBriefingGenerator({ config, createClient: () => client, ...extra });

async function failure(promise: Promise<unknown>): Promise<AiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AiError);
  return error as AiError;
}

describe("request construction", () => {
  it("sends ONE forced, non-parallel tool call with the static system prompt and delimited data", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await generator(client).propose(context, "keep the evening free");
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0]!;
    expect(params.model).toBe("test-model");
    expect(params.system).toBe(BRIEFING_SYSTEM_PROMPT);
    expect(params.tools).toHaveLength(1);
    expect(params.tools![0]).toMatchObject({ name: BRIEFING_TOOL_NAME });
    expect(params.tool_choice).toEqual({
      type: "tool",
      name: BRIEFING_TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    const content = String(params.messages[0]!.content);
    expect(content).toContain("<briefing>");
    expect(content).toContain("renegotiate the Acme contract");
    expect(content).toContain("keep the evening free");
    expect(String(params.system)).not.toContain("Acme");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.timeout).toBe(20_000);
  });

  it("sends no id, note, email or credential", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await generator(client).propose(context, null);
    const sent = JSON.stringify(create.mock.calls[0]![0]);
    expect(sent).not.toContain("PRIVATE-NOTES-DO-NOT-LEAK");
    expect(sent).not.toContain(API_KEY);
    expect(sent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(sent).not.toMatch(/@|userId|dayId|VAPID|CRON_SECRET/);
  });

  it("uses the configured model", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await createAnthropicBriefingGenerator({
      config: () => ({ apiKey: API_KEY, model: "another-model" }),
      createClient: () => client,
    }).propose(context, null);
    expect(create.mock.calls[0]![0].model).toBe("another-model");
  });
});

describe("responses", () => {
  it("returns the tool payload untouched, as unknown", async () => {
    const { client } = fakeClient(async () =>
      message([{ type: "text", text: "sure" }, toolUse(PAYLOAD)]),
    );
    expect(await generator(client).propose(context, null)).toEqual(PAYLOAD);
  });

  it("does not vouch for a malformed payload — Zod and the validator do, downstream", async () => {
    const { client } = fakeClient(async () => message([toolUse({ nonsense: true })]));
    expect(await generator(client).propose(context, null)).toEqual({ nonsense: true });
  });

  it.each([
    ["no tool call", () => message([{ type: "text", text: "I refuse" }], "end_turn")],
    ["a tool with the wrong name", () => message([toolUse(PAYLOAD, "run_sql")])],
    ["more than one tool call", () => message([toolUse(PAYLOAD), toolUse(PAYLOAD)])],
    ["a truncated (max_tokens) response", () => message([toolUse(PAYLOAD)], "max_tokens")],
    ["empty content", () => message([], "end_turn")],
  ])("fails safely with %s — one call, no retry, no repair", async (_label, make) => {
    const { create, client } = fakeClient(async () => make());
    const error = await failure(generator(client).propose(context, null));
    expect(error.reason).toBe("malformed_response");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("configuration", () => {
  it("is 'unavailable' with no config and builds no client", async () => {
    const createClient = vi.fn();
    const error = await failure(
      createAnthropicBriefingGenerator({ config: () => null, createClient }).propose(context, null),
    );
    expect(error.reason).toBe("unavailable");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads the environment at call time (unset → unavailable)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect((await failure(createAnthropicBriefingGenerator().propose(context, null))).reason).toBe(
      "unavailable",
    );
  });
});

describe("provider failures", () => {
  const httpError = (status: number) =>
    Object.assign(new Error(`${status} boom`), { name: "APIError", status });

  it.each([
    [429, "rate_limited"],
    [500, "provider_error"],
    [529, "provider_error"],
    [400, "provider_error"],
    [401, "unavailable"],
    [403, "unavailable"],
  ])("maps HTTP %i to %s and does not retry itself", async (status, reason) => {
    const { create, client } = fakeClient(async () => Promise.reject(httpError(status)));
    const error = await failure(generator(client).propose(context, null));
    expect(error.reason).toBe(reason);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("maps an SDK connection timeout to timeout", async () => {
    const { client } = fakeClient(async () =>
      Promise.reject(
        Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }),
      ),
    );
    expect((await failure(generator(client).propose(context, null))).reason).toBe("timeout");
  });

  it("enforces its own overall timeout by aborting the request", async () => {
    const { client } = fakeClient(
      (_p, o) =>
        new Promise((_, reject) =>
          o!.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const error = await failure(generator(client, { timeoutMs: 20 }).propose(context, null));
    expect(error.reason).toBe("timeout");
  });

  it("respects the caller's AbortSignal", async () => {
    const controller = new AbortController();
    const { client } = fakeClient(
      (_p, o) =>
        new Promise((_, reject) =>
          o!.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const pending = failure(
      generator(client).propose(context, null, { signal: controller.signal }),
    );
    controller.abort();
    expect((await pending).reason).toBe("cancelled");
  });
});

describe("secrets and content never leak", () => {
  it("keeps the key, the briefing and titles out of errors and logs, even when the SDK error has them", async () => {
    const hostile = Object.assign(
      new Error(`401 invalid x-api-key ${API_KEY} for ${TITLE} ${BRIEFING}`),
      { name: "AuthenticationError", status: 401, headers: { "x-api-key": API_KEY } },
    );
    const { client } = fakeClient(async () => Promise.reject(hostile));
    const error = await failure(generator(client).propose(context, null));
    const haystack = `${error.message} ${error.stack} ${String(error.cause)} ${JSON.stringify(error)} ${logged.join("\n")}`;
    for (const secret of [API_KEY, TITLE, "Acme", "Confidential"]) {
      expect(haystack).not.toContain(secret);
    }
    expect(error.cause).not.toBe(hostile);
  });

  it("logs only safe metadata on success — no briefing, no titles, no completion text", async () => {
    const { client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await generator(client).propose(context, "private note text");
    const text = logged.join("\n");
    for (const secret of [BRIEFING, "Acme", TITLE, API_KEY, "private note", "Plan the contract"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("plan-from-briefing-v1");
    expect(text).toContain("test-model");
  });
});

describe("with the real SDK and a stubbed fetch", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const sdk = (fetchImpl: (url: unknown, init?: unknown) => Promise<Response>) =>
    createAnthropicBriefingGenerator({
      config,
      createClient: (apiKey) =>
        new Anthropic({ apiKey, maxRetries: 0, fetch: fetchImpl as typeof fetch }),
    });

  it("returns the payload of a real-shaped response; the key is never in the body", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) =>
      json(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [toolUse(PAYLOAD)],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    expect(await sdk(fetchSpy).propose(context, null)).toEqual(PAYLOAD);
    const init = fetchSpy.mock.calls[0]![1] as { body: string };
    expect(init.body).not.toContain(API_KEY);
    expect(JSON.parse(init.body).tool_choice.name).toBe(BRIEFING_TOOL_NAME);
  });

  it("a 500 from the wire is a provider_error with the status only", async () => {
    const error = await failure(
      sdk(async () =>
        json(500, { type: "error", error: { type: "api_error", message: BRIEFING } }),
      ).propose(context, null),
    );
    expect(error.reason).toBe("provider_error");
    expect(`${error.message} ${String(error.cause)}`).not.toContain("Acme");
  });
});
