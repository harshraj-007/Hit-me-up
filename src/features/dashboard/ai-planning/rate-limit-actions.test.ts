import { describe, expect, it, vi } from "vitest";

// The Server Actions are thin wrappers over `runAction`; this proves the new rate-limit error reaches
// the browser through exactly that boundary — as data, with the safe message, never as a throw.
vi.mock("@/server/services/ai-planning", () => ({
  generateAiProposal: vi.fn(),
  loadPendingAiProposal: vi.fn(),
}));
vi.mock("@/server/services/briefing-plan", () => ({ generateBriefingPlan: vi.fn() }));
vi.mock("@/server/services/ai-confirmation", () => ({
  confirmPersistedAiProposal: vi.fn(),
  discardPersistedAiProposal: vi.fn(),
}));
vi.mock("@/server/services/eod-report", () => ({ generateEodReport: vi.fn() }));
vi.mock("@/server/logging/logger", () => {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => log };
  return { logger: log };
});

import { RateLimitError } from "@/server/errors";
import { generateAiProposal } from "@/server/services/ai-planning";
import { generateBriefingPlan } from "@/server/services/briefing-plan";
import { generateEodReport } from "@/server/services/eod-report";
import { generateAiProposalAction, generateBriefingPlanAction } from "./actions";
import { generateEodReportAction } from "../eod/actions";

const limited = () => new RateLimitError(600, { cause: new Error("ai_usage_events internal") });

describe.each([
  ["generateAiProposalAction", () => generateAiProposalAction({}), generateAiProposal],
  ["generateBriefingPlanAction", () => generateBriefingPlanAction({}), generateBriefingPlan],
  ["generateEodReportAction", () => generateEodReportAction(), generateEodReport],
])("%s", (_name, call, service) => {
  it("returns a safe RATE_LIMITED result (not a thrown error) when the user is over budget", async () => {
    vi.mocked(service as () => Promise<unknown>).mockRejectedValue(limited());
    const result = await call();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "You've used your AI allowance for now. Try again in about 10 minutes.",
      },
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/ai_usage|internal|SELECT|supabase|anthropic|retryAfter|window/i);
  });
});
