import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, buildFor, makeTask } from "../../../tests/support/ai-planning-fixtures";
import type { UserIntent } from "@/domain/ai-planning";
import { AiError } from "./errors";
import { createAnthropicGenerator, type MessagesClient } from "./anthropic";
import { PROPOSAL_TOOL_NAME, SYSTEM_PROMPT } from "./prompt";

const API_KEY = "sk-ant-api03-TOP-SECRET-KEY-123";
const TITLE = "Quarterly tax filing for Alice";
const REQUEST = "please shuffle my private evening plans";
const config = () => ({ apiKey: API_KEY, model: "test-model" });
const intent: UserIntent = {
  id: "0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6a77",
  source: "typed",
  text: REQUEST,
  planningDate: "2026-10-01",
  submittedAt: new Date("2026-10-01T09:00:00Z"),
};
const { context } = buildFor([makeTask({ title: TITLE, start: at(18), end: at(19) })]);

const PAYLOAD = {
  understood: "Move t1 to 8pm.",
  changes: [{ kind: "move", ref: "t1", newStart: "2026-10-01T20:00", reason: "asked" }],
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
const toolUse = (input: unknown, name = PROPOSAL_TOOL_NAME) => ({
  type: "tool_use",
  id: "tu_1",
  name,
  input,
});

/** A stand-in SDK client whose `create` is a spy. */
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
  createAnthropicGenerator({ config, createClient: () => client, ...extra });

async function failure(promise: Promise<unknown>): Promise<AiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AiError);
  return error as AiError;
}
function assertNoLeak(...things: unknown[]) {
  const haystack = things
    .map((t) =>
      t instanceof Error ? `${t.message} ${t.stack} ${String((t as Error).cause)}` : String(t),
    )
    .join("\n");
  for (const secret of [API_KEY, "TOP-SECRET", TITLE, REQUEST])
    expect(haystack).not.toContain(secret);
}

describe("request construction", () => {
  it("sends one forced, non-parallel tool call with a static system prompt and delimited data", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await generator(client).propose(context, intent);
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0]!;
    expect(params.model).toBe("test-model");
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(params.tools).toHaveLength(1);
    expect(params.tools![0]).toMatchObject({ name: PROPOSAL_TOOL_NAME });
    expect(params.tool_choice).toEqual({
      type: "tool",
      name: PROPOSAL_TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    expect(params.messages).toHaveLength(1);
    const content = String(params.messages[0]!.content);
    expect(content).toContain(TITLE);
    expect(content).toContain("<user_request>");
    expect(String(params.system)).not.toContain(TITLE);
    expect(String(params.system)).not.toContain(REQUEST);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.timeout).toBe(20_000);
  });

  it("uses the configured model, never a hard-coded one", async () => {
    const { create, client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await createAnthropicGenerator({
      config: () => ({ apiKey: API_KEY, model: "another-model" }),
      createClient: () => client,
    }).propose(context, intent);
    expect(create.mock.calls[0]![0].model).toBe("another-model");
  });
});

describe("responses", () => {
  it("returns the tool payload untouched, as unknown (no provider type leaks)", async () => {
    const { client } = fakeClient(async () =>
      message([{ type: "text", text: "sure" }, toolUse(PAYLOAD)]),
    );
    const out = await generator(client).propose(context, intent);
    expect(out).toEqual(PAYLOAD);
  });
  it("preserves several changes exactly as sent", async () => {
    const many = {
      ...PAYLOAD,
      changes: [PAYLOAD.changes[0], { kind: "unschedule", ref: "t2", reason: "x" }],
    };
    const { client } = fakeClient(async () => message([toolUse(many)]));
    expect(await generator(client).propose(context, intent)).toEqual(many);
  });
  it("does not vouch for malformed payloads — that is Zod's job, downstream", async () => {
    const { client } = fakeClient(async () => message([toolUse({ nonsense: true })]));
    expect(await generator(client).propose(context, intent)).toEqual({ nonsense: true });
  });
  it.each([
    ["no tool call", () => message([{ type: "text", text: "I refuse" }], "end_turn")],
    ["a tool with the wrong name", () => message([toolUse(PAYLOAD, "run_sql")])],
    ["more than one tool call", () => message([toolUse(PAYLOAD), toolUse(PAYLOAD)])],
    ["a truncated (max_tokens) response", () => message([toolUse(PAYLOAD)], "max_tokens")],
    ["empty content", () => message([], "end_turn")],
  ])("fails safely with %s", async (_label, make) => {
    const { create, client } = fakeClient(async () => make());
    const error = await failure(generator(client).propose(context, intent));
    expect(error.reason).toBe("malformed_response");
    expect(create).toHaveBeenCalledTimes(1); // no retry, no repair call
  });
});

describe("configuration", () => {
  it("is 'unavailable' with no config, and makes no request and builds no client", async () => {
    const createClient = vi.fn();
    const error = await failure(
      createAnthropicGenerator({ config: () => null, createClient }).propose(context, intent),
    );
    expect(error.reason).toBe("unavailable");
    expect(error.message).toBe("AI planning isn't available right now.");
    expect(createClient).not.toHaveBeenCalled();
  });
  it("reads the environment at call time (unset → unavailable)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect((await failure(createAnthropicGenerator().propose(context, intent))).reason).toBe(
      "unavailable",
    );
  });
});

describe("provider failures", () => {
  const httpError = (status: number, msg = "boom") =>
    Object.assign(new Error(`${status} ${msg}`), { name: "APIError", status });
  it.each([
    [429, "rate_limited"],
    [500, "provider_error"],
    [503, "provider_error"],
    [529, "provider_error"],
    [400, "provider_error"],
    [401, "unavailable"],
    [403, "unavailable"],
  ])("maps HTTP %i to %s and does not retry itself", async (status, reason) => {
    const { create, client } = fakeClient(async () => Promise.reject(httpError(status)));
    const error = await failure(generator(client).propose(context, intent));
    expect(error.reason).toBe(reason);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("maps an SDK connection timeout to timeout", async () => {
    const { client } = fakeClient(async () =>
      Promise.reject(
        Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }),
      ),
    );
    expect((await failure(generator(client).propose(context, intent))).reason).toBe("timeout");
  });
  it("maps a network failure with no status to provider_error", async () => {
    const { client } = fakeClient(async () => Promise.reject(new TypeError("fetch failed")));
    expect((await failure(generator(client).propose(context, intent))).reason).toBe(
      "provider_error",
    );
  });
  it("enforces its own overall timeout by aborting the request", async () => {
    const { client } = fakeClient(
      (_p, o) =>
        new Promise((_, reject) =>
          o!.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const error = await failure(generator(client, { timeoutMs: 20 }).propose(context, intent));
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
      generator(client).propose(context, intent, { signal: controller.signal }),
    );
    controller.abort();
    expect((await pending).reason).toBe("cancelled");
  });
  it("an already-aborted caller signal never yields success", async () => {
    const { client } = fakeClient((_p, o) =>
      o!.signal!.aborted
        ? Promise.reject(new Error("aborted"))
        : Promise.resolve(message([toolUse(PAYLOAD)])),
    );
    const error = await failure(
      generator(client).propose(context, intent, { signal: AbortSignal.abort() }),
    );
    expect(error.reason).toBe("cancelled");
  });
});

describe("secrets and content never leak", () => {
  it("keeps the API key, titles and request text out of errors and logs, even when the SDK error contains them", async () => {
    const hostile = Object.assign(
      new Error(`401 invalid x-api-key ${API_KEY} while processing "${REQUEST}" for ${TITLE}`),
      {
        name: "AuthenticationError",
        status: 401,
        headers: { "x-api-key": API_KEY },
        error: { message: TITLE },
      },
    );
    const { client } = fakeClient(async () => Promise.reject(hostile));
    const error = await failure(generator(client).propose(context, intent));
    assertNoLeak(error, JSON.stringify(error), logged.join("\n"));
    expect(error.cause).not.toBe(hostile);
    expect(error.message).toBe("AI planning isn't available right now.");
  });
  it("logs only safe metadata on success", async () => {
    const { client } = fakeClient(async () => message([toolUse(PAYLOAD)]));
    await generator(client).propose(context, intent);
    const text = logged.join("\n");
    assertNoLeak(text);
    expect(text).toContain("anthropic");
    expect(text).toContain("test-model");
    expect(text).not.toContain("Move t1 to 8pm"); // completion text
    expect(text).not.toContain("2026-10-01T20:00");
    expect(text).not.toContain("REDACTED"); // metadata keys are not accidentally masked
  });
  it("logs only safe metadata on failure", async () => {
    const { client } = fakeClient(async () =>
      Promise.reject(Object.assign(new Error(API_KEY), { status: 500 })),
    );
    await failure(generator(client).propose(context, intent));
    assertNoLeak(logged.join("\n"));
    expect(logged.join("\n")).toContain("provider_error");
  });
});

/** The REAL SDK, with only the network replaced, so its actual error classes and response shapes are exercised. */
describe("with the real SDK and a stubbed fetch", () => {
  const sdk = (fetchImpl: (url: unknown, init?: unknown) => Promise<Response>) =>
    createAnthropicGenerator({
      config,
      createClient: (apiKey) =>
        new Anthropic({ apiKey, maxRetries: 0, fetch: fetchImpl as typeof fetch }),
    });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
    expect(await sdk(fetchSpy).propose(context, intent)).toEqual(PAYLOAD);
    const init = fetchSpy.mock.calls[0]![1] as {
      body: string;
      headers: Record<string, string> | Headers;
    };
    expect(init.body).not.toContain(API_KEY);
    const body = JSON.parse(init.body);
    expect(body.tool_choice.name).toBe(PROPOSAL_TOOL_NAME);
    expect(body.system).toBe(SYSTEM_PROMPT);
  });
  it.each([
    [429, "rate_limited", "rate_limit_error"],
    [500, "provider_error", "api_error"],
    [529, "provider_error", "overloaded_error"],
    [401, "unavailable", "authentication_error"],
  ])("maps a real HTTP %i", async (status, reason, type) => {
    const error = await failure(
      sdk(async () =>
        json(status, { type: "error", error: { type, message: `${TITLE} ${API_KEY}` } }),
      ).propose(context, intent),
    );
    expect(error.reason).toBe(reason);
    assertNoLeak(error, logged.join("\n"));
  });
  it("maps a real connection failure", async () => {
    const error = await failure(
      sdk(async () => Promise.reject(new TypeError("network down"))).propose(context, intent),
    );
    expect(error.reason).toBe("provider_error");
  });
});
