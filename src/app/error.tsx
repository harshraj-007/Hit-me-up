"use client";

import { ErrorBoundaryView } from "@/components/ui/error-boundary-view";

export default function RootError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="px-4">
      <ErrorBoundaryView {...props} />
    </main>
  );
}
