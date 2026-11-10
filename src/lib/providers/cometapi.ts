// محوّل CometAPI (المزود الثاني)
// - الصور: نقطة OpenAI-compatible /v1/images/generations تعيد الرابط (أو b64_json) فورًا → متزامنة
// - الفيديو: نقطة مهام غير متزامنة /v1/videos/generations ثم /v1/videos/{task_id}
//   الشكل الموثق لدى CometAPI: الإنشاء يعيد request_id، والاستعلام يعيد data.status
//   (SUCCESS/…) ورابط الفيديو في data.data.video.url — نستخرجه دفاعيًا لأن الشكل قد يتغير.
// ملاحظة: لا يوجد مفتاح CometAPI مُضاف بعد؛ هذا المحوّل يُفعَّل تلقائيًا عند إضافة أول مفتاح.
// يجب التحقق من الأشكال الفعلية بمفتاح حقيقي قبل الاعتماد الكامل عليه (القاعدة الذهبية 10).
import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderKey } from "./types";

const BASE = () => (process.env.COMETAPI_BASE || "https://api.cometapi.com").replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;

async function cometFetch(
  path: string,
  key: ProviderKey,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProviderError(0, `CometAPI network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const errObj = body?.error as { message?: string } | undefined;
    const msg = errObj?.message || (typeof body?.message === "string" && body.message) || `HTTP ${res.status}`;
    throw new ProviderError(res.status, String(msg));
  }
  return body ?? {};
}

/** استخراج أول رابط http/https من أي كائن متداخل (دفاعي) */
function firstUrlDeep(v: unknown, depth = 0): string | null {
  if (depth > 5 || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const found = firstUrlDeep(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = v as Record<string, unknown>;
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val === "string" && /^https?:\/\//.test(val) && /url|video|mp4|link/i.test(k)) return val;
  }
  for (const val of Object.values(obj)) {
    const found = firstUrlDeep(val, depth + 1);
    if (found) return found;
  }
  return null;
}

export const cometAdapter: ProviderAdapter = {
  // الصور متزامنة: تُعاد النتيجة فورًا
  async createImageSync(key: ProviderKey, input: Record<string, unknown>) {
    const body = await cometFetch("/v1/images/generations", key, {
      method: "POST",
      body: JSON.stringify({
        model: input.providerModel,
        prompt: input.prompt,
        n: 1,
        ...(input.size ? { size: input.size } : {}),
      }),
    });
    const data = body.data as Array<Record<string, unknown>> | undefined;
    const first = Array.isArray(data) ? data[0] : undefined;
    const url = typeof first?.url === "string" ? first.url : null;
    if (url) return { urls: [url] };
    // بعض الاستجابات تعيد b64_json — نحوله data URI فقط إن كان حجمه معقولًا (نخزن روابط/بيانات فقط، لا ملفات)
    const b64 = typeof first?.b64_json === "string" ? first.b64_json : null;
    if (b64 && b64.length < 4_000_000) {
      return { urls: [`data:image/png;base64,${b64}`] };
    }
    throw new ProviderError(502, "استجابة صور CometAPI بلا رابط عام صالح");
  },

  async createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>) {
    const body = await cometFetch("/v1/videos/generations", key, {
      method: "POST",
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        ...(input.image_urls ? { image_urls: input.image_urls } : {}),
        ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.duration ? { duration: input.duration } : {}),
      }),
    });
    // الشكل الموثق: request_id — نقبل الصيغ البديلة دفاعيًا
    const taskId =
      (typeof body.request_id === "string" && body.request_id) ||
      (typeof body.task_id === "string" && body.task_id) ||
      ((body.data as Record<string, unknown> | undefined)?.request_id as string | undefined) ||
      ((body.data as Record<string, unknown> | undefined)?.task_id as string | undefined) ||
      null;
    if (!taskId) {
      throw new ProviderError(502, "استجابة غير متوقعة من CometAPI: لا يوجد معرّف مهمة");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key: ProviderKey, providerTaskId: string) {
    const body = await cometFetch(`/v1/videos/${encodeURIComponent(providerTaskId)}`, key);
    const data = (body.data ?? body) as Record<string, unknown>;
    const status = String(data.status ?? "processing").toUpperCase();

    if (status === "SUCCESS" || status === "COMPLETED" || status === "SUCCEEDED" || status === "DONE") {
      const url = firstUrlDeep(data) ?? firstUrlDeep(body);
      if (!url) return { status: "failed" as const, error: "اكتملت المهمة لدى CometAPI دون رابط فيديو" };
      return { status: "completed" as const, urls: [url] };
    }
    if (status === "FAILED" || status === "FAILURE" || status === "ERROR" || status === "CANCELLED") {
      const errObj = data.error as { message?: string } | undefined;
      return { status: "failed" as const, error: String(errObj?.message ?? data.error ?? "فشل المزود دون رسالة") };
    }
    return { status: "processing" as const };
  },
};
