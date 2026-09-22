import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Today" };

export default function TodayPage() {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">Today</h1>
      <EmptyState
        title="Nothing planned yet"
        description="Your daily briefing and plan will appear here in a later phase."
      />
    </>
  );
}
