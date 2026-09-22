"use client";

import { StatusPanel } from "./status-panel";

/** Shared body for error.tsx files. Only the opaque digest is shown; Next logs detail server-side. */
export function ErrorBoundaryView({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StatusPanel
      tone="error"
      title="Something went wrong"
      description="An unexpected error occurred. You can try again."
      reference={error.digest}
      action={{ label: "Try again", onClick: reset }}
    />
  );
}
