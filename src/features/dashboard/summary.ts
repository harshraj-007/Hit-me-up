import type { DashboardTask, DaySummary } from "./types";

export function computeDaySummary(tasks: DashboardTask[], now: Date): DaySummary {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const remainingMinutes = tasks.reduce((sum, t) => {
    if (t.status === "completed" || t.status === "skipped") return sum;
    const effectiveStart = t.start > now ? t.start : now;
    if (t.end <= effectiveStart) return sum;
    return sum + (t.end.getTime() - effectiveStart.getTime()) / 60_000;
  }, 0);
  return { completed, total: tasks.length, remainingMinutes: Math.round(remainingMinutes) };
}
