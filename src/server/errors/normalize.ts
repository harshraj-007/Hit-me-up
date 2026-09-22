import { ZodError } from "zod";
import { AppError, InternalError, ValidationError } from "./app-error";

/** Converts anything thrown into a classified AppError. Unknown errors become InternalError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new ValidationError(
      error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      { cause: error },
    );
  }
  return new InternalError({ cause: error });
}
