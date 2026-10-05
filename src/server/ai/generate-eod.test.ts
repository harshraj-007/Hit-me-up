import { describe, expect, it } from "vitest";
import { computeEodFacts } from "@/domain/eod";
import { at, makeTask, PLANNING_DATE, TZ } from "../../../tests/support/ai-planning-fixtures";
import { AiError } from "./errors";
import { createFakeEodInterpreter } from "./fake";
import { generateEodInterpretation } from "./generate-eod";

const facts = computeEodFacts({
  planningDate: PLANNING_DATE,
  timezone: TZ,
  now: at(21),
  tasks: [
    makeTask({
      title: "Done",
      status: "completed",
      completedAt: at(9, 30),
      start: at(9),
      end: at(10),
    }),
    makeTask({ title: "Slipped", start: at(14), end: at(15) }),
  ],
  history: [],
  revisions: [],
});
const GOOD = {
  summary: "One task slipped past its time.",
  patterns: [{ text: "[t2] got no attention.", refs: ["t2"] }],
  carryForward: [{ ref: "t2", suggestion: "Give it the first slot tomorrow." }],
  takeaway: "Protect time for the hard thing first.",
};

async function rejection(payload: unknown) {
  const error = await generateEodInterpretation(createFakeEodInterpreter(payload), facts).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AiError);
  return error as AiError;
}

describe("generateEodInterpretation", () => {
  it("returns a validated interpretation for a good payload", async () => {
    const { interpretation, dropped } = await generateEodInterpretation(
      createFakeEodInterpreter(GOOD),
      facts,
    );
    expect(interpretation).toEqual({
      summary: GOOD.summary,
      takeaway: GOOD.takeaway,
      patterns: [{ text: "[t2] got no attention.", refs: ["t2"] }],
      carryForward: [{ ref: "t2", suggestion: "Give it the first slot tomorrow." }],
    });
    expect(dropped).toEqual([]);
  });

  it("hands the interpreter the deterministic facts and nothing else", async () => {
    const fake = createFakeEodInterpreter(GOOD);
    await generateEodInterpretation(fake, facts, {});
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.facts).toBe(facts);
  });

  describe("malformed model output fails safely as malformed_response", () => {
    it.each([
      ["null", null],
      ["a string", "here is my review"],
      ["an array", []],
      ["an empty object", {}],
      ["missing the takeaway", { ...GOOD, takeaway: undefined }],
      [
        "missing the summary",
        { summary: undefined, takeaway: "t", patterns: [], carryForward: [] },
      ],
      ["a wrong type", { ...GOOD, summary: 5 }],
      ["a hidden extra field", { ...GOOD, markTaskCompleted: "t2" }],
      ["a summary stating a number", { ...GOOD, summary: "You completed 7 tasks." }],
      ["a takeaway with a link", { ...GOOD, takeaway: "Read https://evil.example" }],
      ["a summary about a task that doesn't exist", { ...GOOD, summary: "[t9] was great." }],
    ])("%s", async (_label, payload) => {
      const error = await rejection(payload);
      expect(error.reason).toBe("malformed_response");
      expect(error.message).toBe("The AI's response couldn't be used. Please try again.");
    });
  });

  describe("fabrication in list entries is dropped, not trusted", () => {
    it("drops a carry-forward for a COMPLETED task and a made-up ref, keeping the valid one", async () => {
      const { interpretation, dropped } = await generateEodInterpretation(
        createFakeEodInterpreter({
          ...GOOD,
          carryForward: [
            { ref: "t1", suggestion: "Do it again." },
            { ref: "t99", suggestion: "Do the invented one." },
            { ref: "t2", suggestion: "Give it the first slot tomorrow." },
          ],
        }),
        facts,
      );
      expect(interpretation.carryForward).toEqual([
        { ref: "t2", suggestion: "Give it the first slot tomorrow." },
      ]);
      expect(dropped).toHaveLength(2);
    });

    it("drops a pattern naming a fabricated task but keeps the response", async () => {
      const { interpretation } = await generateEodInterpretation(
        createFakeEodInterpreter({
          ...GOOD,
          patterns: [
            { text: "Something about [t42].", refs: [] },
            { text: "A fair point.", refs: [] },
          ],
        }),
        facts,
      );
      expect(interpretation.patterns).toEqual([{ text: "A fair point.", refs: [] }]);
    });
  });

  describe("provider failures propagate unchanged and persist nothing", () => {
    it.each(["timeout", "rate_limited", "provider_error", "unavailable"] as const)(
      "%s",
      async (reason) => {
        const failing = createFakeEodInterpreter(() => {
          throw new AiError(reason, undefined, "review");
        });
        await expect(generateEodInterpretation(failing, facts)).rejects.toMatchObject({ reason });
      },
    );
  });

  it("this module never sees a repository: it has no way to write anything", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./generate-eod.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/repositories|supabase|\.rpc\(|\.insert\(/i);
  });
});
