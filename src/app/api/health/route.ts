import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/errors";
import { getHealthReport } from "@/server/services/health";

export const dynamic = "force-dynamic";

/** Public liveness/readiness probe. Exposes coarse status only — no versions, hosts or errors. */
export const GET = withErrorHandling(async () => {
  const report = await getHealthReport();
  return NextResponse.json(report, {
    status: report.status === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
});
