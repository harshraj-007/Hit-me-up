import { describe, expect, it } from "vitest";
import { at, makeTask, PLANNING_DATE, TZ } from "../../../tests/support/ai-planning-fixtures";
import {
  checkProse,
  computeEodFacts,
  renderRefs,
  validateEodInterpretation,
  type EodFacts,
  type ParsedInterpretation,
} from "./index";

// t1 completed, t2 skipped, t3 slipped, t4 in progress, t5 not yet due, t6 unscheduled.
const FACTS: EodFacts = computeEodFacts({
  planningDate: PLANNING_DATE,
  timezone: TZ,
  now: at(21),
  tasks: [
    makeTask({
      title: "Gym 5K",
      status: "completed",
      completedAt: at(8, 30),
      start: at(8),
      end: at(9),
    }),
    makeTask({ title: "Skip me", status: "skipped", start: at(9), end: at(10) }),
    makeTask({ title: "Slipped one", start: at(14), end: at(15) }),
    makeTask({ title: "Running", start: at(20), end: at(22) }),
    makeTask({ title: "Later", start: at(22), end: at(23) }),
    makeTask({ title: "No room", unscheduled: true, start: at(16), end: at(17) }),
  ],
  history: [],
  revisions: [],
});
const REF = Object.fromEntries(FACTS.tasks.map((t) => [t.title, t.ref]));

function parsed(over: Partial<ParsedInterpretation> = {}): ParsedInterpretation {
  return {
    summary: "A steady day with one task that got away.",
    takeaway: "Protect the afternoon block.",
    patterns: [],
    carryForward: [],
    rejected: [],
    ...over,
  };
}

describe("checkProse", () => {
  const refs = new Set(["t1", "t2"]);
  it.each([
    ["plain prose", "You kept the morning clear.", null],
    ["a valid placeholder", "[t1] went well.", null],
    ["digits", "You finished 3 tasks.", "states a number or time (those come from the facts)"],
    ["a clock time", "Start at 9am.", "states a number or time (those come from the facts)"],
    ["an unknown placeholder", "[t9] slipped.", "names a task that does not exist"],
    ["a stray bracket", "Did [this] happen?", "contains a bracket that is not a task placeholder"],
    ["markup", "Use <b>bold</b>.", "contains markup, a link or a control character"],
    ["a link", "See https://evil.example now.", "contains markup, a link or a control character"],
    ["a code fence", "Run `rm -rf`.", "contains markup, a link or a control character"],
    ["a newline", "Line one\nline two", "contains markup, a link or a control character"],
    ["a template brace", "Hello {name}", "contains markup, a link or a control character"],
    ["empty", "", "empty"],
  ])("%s", (_label, text, expected) => {
    expect(checkProse(text, 200, refs)).toBe(expected);
  });

  it("rejects text over the length limit", () => {
    expect(checkProse("x".repeat(11), 10, refs)).toBe("too long");
  });

  it("a digit INSIDE a valid placeholder alias is fine — it is replaced by a title, not shown", () => {
    expect(checkProse("[t2] needs a decision.", 200, refs)).toBeNull();
  });
});

describe("validateEodInterpretation — whole-response rules", () => {
  it("accepts a clean interpretation", () => {
    const v = validateEodInterpretation(FACTS, parsed());
    expect(v.ok).toBe(true);
  });

  it.each([
    ["a summary with a number", { summary: "You completed 5 tasks." }],
    ["a takeaway with a time", { takeaway: "Start at 8." }],
    ["a summary naming a task that does not exist", { summary: "[t42] was the problem." }],
    ["a takeaway with markup", { takeaway: "<script>x</script>" }],
    ["a summary that is far too long", { summary: "word ".repeat(200) }],
    ["an empty takeaway", { takeaway: "" }],
  ])("fails the response for %s", (_label, over) => {
    expect(validateEodInterpretation(FACTS, parsed(over)).ok).toBe(false);
  });

  it("refuses to interpret an empty day at all", () => {
    const empty = computeEodFacts({
      planningDate: PLANNING_DATE,
      timezone: TZ,
      now: at(21),
      tasks: [],
      history: [],
      revisions: [],
    });
    expect(validateEodInterpretation(empty, parsed())).toEqual({
      ok: false,
      reason: "there is nothing to interpret",
    });
  });
});

describe("validateEodInterpretation — carry-forward (fabricated or impossible entries)", () => {
  const carry = (ref: string, suggestion = "Give it a fresh slot tomorrow.") => ({
    ref,
    suggestion,
  });

  it("keeps entries for tasks whose outcome is genuinely unresolved", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({
        carryForward: [
          carry(REF["Slipped one"]!),
          carry(REF["Running"]!),
          carry(REF["Later"]!),
          carry(REF["No room"]!),
        ],
      }),
    );
    expect(v.ok && v.interpretation.carryForward.map((c) => c.ref)).toEqual([
      REF["Slipped one"],
      REF["Running"],
      REF["Later"],
      REF["No room"],
    ]);
  });

  it("DROPS a completed or skipped task the model tries to carry forward, keeping the rest", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({
        carryForward: [carry(REF["Gym 5K"]!), carry(REF["Skip me"]!), carry(REF["Slipped one"]!)],
      }),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.interpretation.carryForward.map((c) => c.ref)).toEqual([REF["Slipped one"]]);
    expect(v.dropped.map((d) => d.reason)).toEqual([
      "carries forward a task that is not unresolved",
      "carries forward a task that is not unresolved",
    ]);
  });

  it("DROPS a fabricated ref (a task that does not exist, or an id-shaped string)", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({ carryForward: [carry("t99"), carry("0b7e3c1e-5a52-4b6c-9d0f-2f1a4f5e6a77")] }),
    );
    expect(v.ok && v.interpretation.carryForward).toEqual([]);
    expect(v.ok && v.dropped.every((d) => d.reason === "names a task that does not exist")).toBe(
      true,
    );
  });

  it("keeps a task only once", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({ carryForward: [carry(REF["Slipped one"]!), carry(REF["Slipped one"]!, "Again.")] }),
    );
    expect(v.ok && v.interpretation.carryForward).toHaveLength(1);
    expect(v.ok && v.dropped[0]?.reason).toBe("names the same task twice");
  });

  it("drops an entry whose suggestion states a number, and caps the list at five", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({ carryForward: [carry(REF["Slipped one"]!, "Do it at 9am.")] }),
    );
    expect(v.ok && v.interpretation.carryForward).toEqual([]);
    const many = validateEodInterpretation(
      FACTS,
      parsed({
        carryForward: [REF["Slipped one"], REF["Running"], REF["Later"], REF["No room"]].map((r) =>
          carry(r!),
        ),
      }),
    );
    expect(many.ok && many.interpretation.carryForward.length).toBeLessThanOrEqual(5);
  });
});

describe("validateEodInterpretation — patterns", () => {
  it("keeps a supported pattern and dedupes its refs", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({
        patterns: [
          { text: "[t3] keeps getting pushed.", refs: [REF["Slipped one"]!, REF["Slipped one"]!] },
        ],
      }),
    );
    expect(v.ok && v.interpretation.patterns).toEqual([
      { text: "[t3] keeps getting pushed.", refs: [REF["Slipped one"]] },
    ]);
  });

  it("drops a pattern that names a task that does not exist, or states a number", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({
        patterns: [
          { text: "Fine.", refs: ["t99"] },
          { text: "Moved 4 times.", refs: [] },
          { text: "[t77] again.", refs: [] },
          { text: "A real observation.", refs: [REF["Slipped one"]!] },
        ],
      }),
    );
    expect(v.ok && v.interpretation.patterns.map((p) => p.text)).toEqual(["A real observation."]);
    expect(v.ok && v.dropped).toHaveLength(3);
  });

  it("keeps at most three patterns", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({ patterns: Array.from({ length: 6 }, () => ({ text: "Observed.", refs: [] })) }),
    );
    expect(v.ok && v.interpretation.patterns).toHaveLength(3);
  });

  it("carries through entries the shape parser already rejected, for the caller's count", () => {
    const v = validateEodInterpretation(
      FACTS,
      parsed({ rejected: [{ section: "pattern", index: 0, reason: "malformed item" }] }),
    );
    expect(v.ok && v.dropped).toEqual([{ section: "pattern", index: 0, reason: "malformed item" }]);
  });
});

describe("renderRefs — the model never writes a title", () => {
  it("replaces each [tN] with that task's own title from the facts", () => {
    expect(renderRefs("[t1] went well but [t3] did not.", FACTS.tasks)).toBe(
      "Gym 5K went well but Slipped one did not.",
    );
  });

  it("an alias with no task renders as a neutral word, never the alias", () => {
    expect(renderRefs("[t99] vanished.", FACTS.tasks)).toBe("a task vanished.");
  });

  it("leaves text without placeholders untouched", () => {
    expect(renderRefs("Nothing to name.", FACTS.tasks)).toBe("Nothing to name.");
  });

  it("a title containing digits or markup is substituted verbatim (it is the user's own text)", () => {
    const tasks = [{ ...FACTS.tasks[0]!, title: "Plan v2 <b>" }];
    expect(renderRefs("[t1] is next.", tasks)).toBe("Plan v2 <b> is next.");
  });
});
