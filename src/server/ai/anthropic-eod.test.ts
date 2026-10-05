import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeEodFacts } from "@/domain/eod";
import { at, makeTask, PLANNING_DATE, TZ } from "../../../tests/support/ai-planning-fixtures";
import { type MessagesClient } from "./anthropic";
import { createAnthropicEodInterpreter } from "./anthropic-eod";
import { AiError } from "./errors";
import { EOD_SYSTEM_PROMPT, EOD_TOOL_NAME } from "./eod-prompt";

const API_KEY = "sk-ant-api03-TOP-SECRET-KEY-123";
const TITLE = "Quarterly tax filing for Alice";
const config = () => ({ apiKey: API_KEY, model: "test-model" });
const facts = computeEodFacts({
  planningDate: PLANNING_DATE,
  timezone: TZ,
  now: at(21),
  tasks: [makeTask({ title: TITLE, start: at(14), end: at(15) })],
  history: [],
  revisions: [],
});

const PAYLOAD = {
  summary: "One task slipped.",
  patterns: [],
  carryForward: [{ ref: "t1", suggestion: "Give it a slot." }],
  takeaway: "Start earlier.",
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
const toolUse = (input: unknown, name = EOD_TOOL_NAME) => ({
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

const interpreter = (client: MessagesClient, extra = {}) =>
  createAnthropicEodInterpreter({ config, createClient: () => client, ...extra });

async function failure(promise: Promise<unknown>): Promise<AiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AiError);
  return error as AiError;
}

describe("request construction", () => {
  it("sends one forced, non-parallel tool call with a static system prompt and delimited facts", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await interpreter(client).interpret(facts);
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0]!;
    expect(params.model).toBe("test-model");
    expect(params.system).toBe(EOD_SYSTEM_PROMPT);
    expect(params.tools).toHaveLength(1);
    expect(params.tools![0]).toMatchObject({ name: EOD_TOOL_NAME });
    expect(params.tool_choice).toEqual({
      type: "tool",
      name: EOD_TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    const content = String(params.messages[0]!.content);
    expect(content).toContain(TITLE);
    expect(content).toContain("<tasks>");
    expect(String(params.system)).not.toContain(TITLE);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.timeout).toBe(20_000);
  });

  it("sends no task id, note, or credential in the request", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await interpreter(client).interpret(facts);
    const sent = JSON.stringify(create.mock.calls[0]![0]);
    expect(sent).not.toContain("PRIVATE-NOTES-DO-NOT-LEAK");
    expect(sent).not.toContain(API_KEY);
    expect(sent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("uses the configured model, never a hard-coded one", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await createAnthropicEodInterpreter({
      config: () => ({ apiKey: API_KEY, model: "another-model" }),
      createClient: () => client,
    }).interpret(facts);
    expect(create.mock.calls[0]![0].model).toBe("another-model");
  });
});

describe("responses", () => {
  it("returns the tool payload untouched, as unknown", async () => {
    const { client } = fakeClient(async () =>
      message([{ type: "text", text: "sure" }, toolUse(PAYLOAD)]),
    );
    expect(await interpreter(client).interpret(facts)).toEqual(PAYLOAD);
  });

  it("does not vouch for malformed payloads — that is Zod's and the validator's job, downstream", async () => {
    const { client } = fakeClient(async () => message([toolUse({ nonsense: true })]));
    expect(await interpreter(client).interpret(facts)).toEqual({ nonsense: true });
  });

  it.each([
    ["no tool call", () => message([{ type: "text", text: "I refuse" }], "end_turn")],
    ["a tool with the wrong name", () => message([toolUse(PAYLOAD, "run_sql")])],
    ["more than one tool call", () => message([toolUse(PAYLOAD), toolUse(PAYLOAD)])],
    ["a truncated (max_tokens) response", () => message([toolUse(PAYLOAD)], "max_tokens")],
    ["empty content", () => message([], "end_turn")],
  ])("fails safely with %s", async (_label, make) => {
    const { create, client } = fakeClient(async () => make());
    const error = await failure(interpreter(client).interpret(facts));
    expect(error.reason).toBe("malformed_response");
    expect(create).toHaveBeenCalledTimes(1); // no retry, no repair call
  });
});

describe("configuration", () => {
  it("is 'unavailable' with no config, with review-specific wording, and builds no client", async () => {
    const createClient = vi.fn();
    const error = await failure(
      createAnthropicEodInterpreter({ config: () => null, createClient }).interpret(facts),
    );
    expect(error.reason).toBe("unavailable");
    expect(error.message).toBe("The end-of-day review isn't available right now.");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads the environment at call time (unset → unavailable)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect((await failure(createAnthropicEodInterpreter().interpret(facts))).reason).toBe(
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
    const error = await failure(interpreter(client).interpret(facts));
    expect(error.reason).toBe(reason);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("maps an SDK connection timeout to timeout", async () => {
    const { client } = fakeClient(async () =>
      Promise.reject(
        Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }),
      ),
    );
    expect((await failure(interpreter(client).interpret(facts))).reason).toBe("timeout");
  });

  it("enforces its own overall timeout by aborting the request", async () => {
    const { client } = fakeClient(
      (_p, o) =>
        new Promise((_, reject) =>
          o!.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const error = await failure(interpreter(client, { timeoutMs: 20 }).interpret(facts));
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
    const pending = failure(interpreter(client).interpret(facts, { signal: controller.signal }));
    controller.abort();
    expect((await pending).reason).toBe("cancelled");
  });
});

describe("secrets and content never leak", () => {
  it("keeps the API key and titles out of errors and logs, even when the SDK error contains them", async () => {
    const hostile = Object.assign(new Error(`401 invalid x-api-key ${API_KEY} for ${TITLE}`), {
      name: "AuthenticationError",
      status: 401,
      headers: { "x-api-key": API_KEY },
    });
    const { client } = fakeClient(async () => Promise.reject(hostile));
    const error = await failure(interpreter(client).interpret(facts));
    const haystack = `${error.message} ${error.stack} ${String(error.cause)} ${JSON.stringify(error)} ${logged.join("\n")}`;
    expect(haystack).not.toContain(API_KEY);
    expect(haystack).not.toContain(TITLE);
    expect(error.cause).not.toBe(hostile);
    expect(error.message).toBe("The end-of-day review isn't available right now.");
  });

  it("logs only safe metadata on success — no titles, no completion text", async () => {
    const { client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await interpreter(client).interpret(facts);
    const text = logged.join("\n");
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("One task slipped");
    expect(text).toContain("test-model");
  });
});

describe("with the real SDK and a stubbed fetch", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const sdk = (fetchImpl: (url: unknown, init?: unknown) => Promise<Response>) =>
    createAnthropicEodInterpreter({
      config,
      createClient: (apiKey) =>
        new Anthropic({ apiKey, maxRetries: 0, fetch: fetchImpl as typeof fetch }),
    });

  it("returns the tool payload from a real-shaped response and sends the key only as a header", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) =>
      json(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [toolUse(PAYLOAD)],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    );
    expect(await sdk(fetchSpy).interpret(facts)).toEqual(PAYLOAD);
    const init = fetchSpy.mock.calls[0]![1] as { body: string };
    expect(init.body).not.toContain(API_KEY);
    expect(JSON.parse(init.body).tool_choice.name).toBe(EOD_TOOL_NAME);
  });

  it.each([
    [429, "rate_limited", "rate_limit_error"],
    [500, "provider_error", "api_error"],
    [401, "unavailable", "authentication_error"],
  ])("maps a real HTTP %i without leaking its body", async (status, reason, type) => {
    const error = await failure(
      sdk(async () =>
        json(status, { type: "error", error: { type, message: `${TITLE} ${API_KEY}` } }),
      ).interpret(facts),
    );
    expect(error.reason).toBe(reason);
    expect(`${error.message} ${String(error.cause)} ${logged.join("\n")}`).not.toContain(API_KEY);
  });
});
