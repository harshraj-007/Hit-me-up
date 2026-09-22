import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "History" };

export default function HistoryPage() {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">History</h1>
      <EmptyState
        title="No history yet"
        description="Past plans and reports will be listed here."
      />
    </>
  );
}
