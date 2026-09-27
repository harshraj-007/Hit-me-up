import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p);
const nonTest = (p: string) => !/\.test\.tsx?$/.test(p);
const files = walk(SRC);
const voiceFiles = files.filter((f) => rel(f).startsWith(path.join("lib", "voice")) && nonTest(f));
const aiPlanningUiFiles = files.filter(
  (f) => rel(f).startsWith(path.join("features", "dashboard", "ai-planning")) && nonTest(f),
);

/**
 * Phase 5.4 security/architecture regression: voice is an input MODALITY, never a mutation
 * pathway, and never carries audio to the AI provider. These assertions are structural (they
 * scan source text) rather than behavioral, because the properties they guard — "there is no
 * audio object anywhere", "the provider layer knows nothing about the browser" — are best
 * proven by showing the code that could violate them doesn't exist, not by exercising a path
 * that was never wired up in the first place.
 */
describe("voice input never reaches the AI provider as audio", () => {
  it("no voice/UI file imports the Anthropic SDK, or any other AI/STT provider SDK", () => {
    for (const f of [...voiceFiles, ...aiPlanningUiFiles]) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(/@anthropic-ai\/|openai|@google\/genai|whisper|deepgram/i);
    }
  });

  it("the voice module never actually USES an audio Blob, MediaRecorder, or file upload (the word may appear only in prose explaining why not)", () => {
    for (const f of voiceFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(
        /new MediaRecorder|new Blob\(|new FormData\(|\.getUserMedia\(|\bfetch\(/,
      );
    }
  });

  it("the provider layer (server/ai) has no knowledge of voice, microphones, or the browser", () => {
    const providerFiles = files.filter(
      (f) => rel(f).startsWith(path.join("server", "ai")) && nonTest(f),
    );
    for (const f of providerFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(
        /SpeechRecognition|MediaRecorder|microphone|transcript|@\/lib\/voice/i,
      );
    }
  });
});

describe("voice cannot bypass confirmation or call the mutation RPC directly", () => {
  it("no voice/UI file CALLS an RPC directly (a doc comment naming one, e.g. explaining why a Server Action exists, is fine — only an actual `.rpc(...)` invocation is not)", () => {
    for (const f of [...voiceFiles, ...aiPlanningUiFiles]) {
      expect(fs.readFileSync(f, "utf8"), rel(f)).not.toMatch(/\.rpc\(/);
    }
  });

  it("confirmAiProposalAction is CALLED only inside the hook's confirm(), never from a transcription or generation callback", () => {
    const hookSource = fs.readFileSync(
      path.join(SRC, "features", "dashboard", "ai-planning", "use-ai-plan-flow.ts"),
      "utf8",
    );
    // Only count real call sites, i.e. `confirmAiProposalAction(` — not the import statement
    // or a prose mention of the name in a comment.
    const callSites = hookSource.match(/confirmAiProposalAction\(/g) ?? [];
    expect(callSites).toHaveLength(1);
    const callIndex = hookSource.indexOf("confirmAiProposalAction(");
    const confirmFnIndex = hookSource.indexOf("const confirm = ");
    const stopRecordingIndex = hookSource.indexOf("const stopRecording = ");
    const submitIndex = hookSource.indexOf("const submit = ");
    expect(callIndex).toBeGreaterThan(confirmFnIndex);
    // and strictly after every other action's definition, i.e. not inside them
    expect(callIndex).toBeGreaterThan(stopRecordingIndex);
    expect(callIndex).toBeGreaterThan(submitIndex);
  });

  it("no voice/UI file imports the Supabase client or a repository directly", () => {
    for (const f of [...voiceFiles, ...aiPlanningUiFiles]) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(/@supabase\/|@\/server\/db\//);
    }
  });
});

describe("no secrets or identity reach the transcription mechanism", () => {
  it("the voice module reads no environment variable and holds no credential-shaped value", () => {
    for (const f of voiceFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(/process\.env|ANTHROPIC_|API_KEY|apiKey/);
    }
  });

  it("the voice module never references a user id, email, or auth/session-token concept", () => {
    for (const f of voiceFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(
        /\buserId\b|\buser_id\b|\bsessionToken\b|\baccessToken\b|auth\.uid|requireUser|\bemail\b/i,
      );
    }
  });
});
