// محوّل kie.ai — Jobs API الموحد (المزود الأساسي)
// الشكل الحقيقي المقاس فعليًا:
//   POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"..."}}
//   GET  /api/v1/jobs/recordInfo?taskId=  → data.state: waiting|queuing|generating|success|fail
//     data.resultJson نص JSON داخل JSON يحتاج JSON.parse ثانية: {"resultUrls":["https://..."]}
// ملاحظة: kie.ai قد يعيد HTTP 200 مع code خطأ داخل الجسم — لذا نعتمد body.code حين يوجد.
import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderKey } from "./types";

const BASE = "https://api.kie.ai";
const TIMEOUT_MS = 30_000;

async function kieFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ""}`,
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // انقطاع شبكة/timeout → مؤقت
    throw new ProviderError(0, `kie.ai network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const code = typeof body?.code === "number" ? body.code : undefined;
  if (!res.ok || (code !== undefined && code !== 200)) {
    const msg =
      (typeof body?.msg === "string" && body.msg) ||
      (typeof (body?.data as Record<string, unknown> | undefined)?.failMsg === "string" &&
        String((body?.data as Record<string, unknown>).failMsg)) ||
      `HTTP ${res.status}`;
    // code داخل الجسم أدق من حالة HTTP عند هذا المزود
    throw new ProviderError(code && code !== 200 ? code : res.status, String(msg));
  }
  return body ?? {};
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>) {
    const body = await kieFetch("/api/v1/jobs/createTask", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.api_key}` },
      body: JSON.stringify({ model: providerModel, input }),
    });
    const data = body.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId ? String(data.taskId) : null;
    if (!taskId) {
      throw new ProviderError(502, "استجابة غير متوقعة من kie.ai: لا يوجد taskId");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string) {
    const body = await kieFetch(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      headers: { Authorization: `Bearer ${key.api_key}` },
    });
    const data = (body.data ?? {}) as Record<string, unknown>;
    const state = String(data.state ?? "waiting");

    if (state === "success") {
      const urls: string[] = [];
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانية
      if (typeof data.resultJson === "string") {
        try {
          const parsed = JSON.parse(data.resultJson) as { resultUrls?: string[] };
          if (Array.isArray(parsed.resultUrls)) urls.push(...parsed.resultUrls.filter((u) => typeof u === "string"));
        } catch {
          // تجاهل — نجرّب الحقل البديل response.resultUrls
        }
      }
      if (urls.length === 0) {
        const resp = data.response as { resultUrls?: string[] } | undefined;
        if (Array.isArray(resp?.resultUrls)) urls.push(...resp.resultUrls);
      }
      if (urls.length === 0) {
        return { status: "failed" as const, error: "اكتملت المهمة لدى kie.ai دون روابط نتائج" };
      }
      return { status: "completed" as const, urls };
    }

    if (state === "fail") {
      return { status: "failed" as const, error: String(data.failMsg ?? "فشل المزود دون رسالة") };
    }

    // waiting | queuing | generating — تقدير تقدم تقريبي على مستوى المنسّق
    return { status: "processing" as const };
  },
};
