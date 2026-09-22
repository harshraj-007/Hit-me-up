import type { Metadata } from "next";
import { DashboardView } from "@/features/dashboard/dashboard-view";

export const metadata: Metadata = { title: "Today" };

export default function TodayPage() {
  return <DashboardView />;
}
