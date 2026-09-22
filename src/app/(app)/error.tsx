"use client";

import { ErrorBoundaryView } from "@/components/ui/error-boundary-view";

export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorBoundaryView {...props} />;
}
