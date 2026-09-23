import { z } from "zod";

/** A `days.local_date` identity key, e.g. "2026-09-22". */
export const localDateSchema = z.iso.date();

export const timezoneSchema = z.string().min(1).max(100);
