import "server-only";
import { probeDatabase, type DependencyStatus } from "@/server/db/health";

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  checks: { database: DependencyStatus };
}

export async function getHealthReport(): Promise<HealthReport> {
  const database = await probeDatabase();
  const status = database === "ok" ? "ok" : database === "unavailable" ? "down" : "degraded";
  return { status, timestamp: new Date().toISOString(), checks: { database } };
}
