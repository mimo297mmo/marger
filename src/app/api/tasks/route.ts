// لوحة المهام — أحدث المهام + الإحصائيات (تستقصيها الواجهة كل ~5 ثوانٍ)
import { listRecentTasks, taskStats } from "@/lib/turso";
import type { MediaType, TaskStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 1), 100);
  const type = (url.searchParams.get("type") ?? undefined) as MediaType | undefined;
  const status = (url.searchParams.get("status") ?? undefined) as TaskStatus | undefined;

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, {
      type: type && ["image", "video", "merge"].includes(type) ? type : undefined,
      status: status && ["completed", "failed", "processing", "pending"].includes(status) ? status : undefined,
    }),
    taskStats(),
  ]);

  return Response.json({ tasks, stats });
}
