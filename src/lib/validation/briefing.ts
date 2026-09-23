import { z } from "zod";

export const BRIEFING_MAX_LENGTH = 4000;

export const createBriefingInputSchema = z.object({
  rawText: z.string().trim().min(1, "Briefing can't be empty.").max(BRIEFING_MAX_LENGTH),
});

export type CreateBriefingInput = z.infer<typeof createBriefingInputSchema>;
