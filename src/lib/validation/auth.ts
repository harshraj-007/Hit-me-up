import { z } from "zod";

export const emailInputSchema = z.object({
  email: z.email("Enter a valid email address."),
});

export type EmailInput = z.infer<typeof emailInputSchema>;
