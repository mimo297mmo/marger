// فحص الصحة — حالة قاعدة Turso + ملخص الموديلات + جهوزية خدمة الدمج + هل يتطلب /mcp توثيقًا
import { dbHealthy } from "@/lib/turso";
import { modelsSummary } from "@/lib/models";
import { checkMergerHealth, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dbOk = await dbHealthy();
  const mergerHealthy = mergerConfigured() ? await checkMergerHealth() : false;

  return Response.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "unavailable",
      mcpEndpoint: "/mcp",
      models: modelsSummary(),
      merger: {
        base: mergerConfigured() ? (process.env.MERGER_API_BASE || "").replace(/\/+$/, "") : null,
        healthy: mergerHealthy,
      },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: 200 },
  );
}
