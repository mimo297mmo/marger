// عميل خدمة دمج الفيديو — Video Merger API v2
// بلا مفاتيح أو توثيق — العنوان من MERGER_API_BASE. المخرجات: MP4 (H.264+AAC) حتى 1080p بجودة CRF 18.
// القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
// وكل الملفات تُحذف تلقائيًا بعد 24 ساعة (expiresAt).
// قاعدة حتمية: أي خطأ HTTP معلَن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة.
// أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → يُستمر بالاستعلام.

export class MergerError extends Error {
  constructor(
    public status: number,
    message: string,
    /** final=true ⇒ فشل حتمي من الخدمة (HTTP معلَن) — لا تكرار المحاولة */
    public final: boolean,
  ) {
    super(message);
    this.name = "MergerError";
  }
}

export function mergerConfigured(): boolean {
  return Boolean((process.env.MERGER_API_BASE || "").trim());
}

function base(): string {
  return (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
}

/** نداء خام لخدمة الدمج — يميّز أخطاء الخدمة الحتمية عن أخطاء الشبكة المؤقتة */
async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new MergerError(0, `خطأ شبكة مع خدمة الدمج: ${e instanceof Error ? e.message : String(e)}`, false);
  }
  let body: Record<string, unknown> | null = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const msg = (typeof body?.error === "string" && body.error) || `HTTP ${res.status}`;
    throw new MergerError(res.status, String(msg), true);
  }
  return { status: res.status, body };
}

export interface MergeJobCreated {
  jobId: string;
  statusUrl?: string;
}

/** POST /api/jobs — إنشاء مهمة دمج بقائمة روابط مباشرة */
export async function createMergeJob(urls: string[]): Promise<MergeJobCreated> {
  const { body } = await mergerFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  });
  const jobId = typeof body?.jobId === "string" ? body.jobId : null;
  if (!jobId) {
    throw new MergerError(502, "استجابة غير متوقعة من خدمة الدمج: لا يوجد jobId", true);
  }
  return { jobId, statusUrl: typeof body?.statusUrl === "string" ? body.statusUrl : undefined };
}

export interface MergeJobStatus {
  status: "processing" | "completed" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  notFound?: boolean;
}

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED_RE = /^(error|failed|failure|cancelled)$/i;

/**
 * GET /api/jobs/{jobId} — تحليل دفاعي للحالة:
 * - قد يرد الجسم فيه error بلا حقل status → نعاملها failed فورًا
 * - progress قد يأتي كسرًا 0..1 → نضربه في 100
 * - 404 → المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
 */
export async function getMergeJob(jobId: string): Promise<MergeJobStatus> {
  let status: number;
  let body: Record<string, unknown> | null;
  try {
    ({ status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`));
  } catch (e) {
    if (e instanceof MergerError && e.status === 404) {
      return { status: "failed", progress: 0, notFound: true, error: e.message };
    }
    throw e;
  }
  const rawStatus = typeof body?.status === "string" ? body.status.trim() : "";
  const rawError = typeof body?.error === "string" ? body.error : undefined;
  const rawProgress = typeof body?.progress === "number" ? body.progress : 0;
  const progress = Math.min(100, Math.max(0, rawProgress <= 1 ? rawProgress * 100 : rawProgress));

  // جسم فيه error بلا status → فشل فوري
  if (!rawStatus && rawError) {
    return { status: "failed", progress, error: rawError };
  }
  if (DONE_RE.test(rawStatus)) {
    const videoUrl = typeof body?.videoUrl === "string" ? body.videoUrl : undefined;
    const downloadUrl = typeof body?.downloadUrl === "string" ? body.downloadUrl : undefined;
    return { status: "completed", progress: 100, videoUrl, downloadUrl };
  }
  if (FAILED_RE.test(rawStatus)) {
    return { status: "failed", progress, error: rawError ?? "فشلت خدمة الدمج دون رسالة" };
  }
  return { status: "processing", progress, error: rawError };
}

/**
 * POST /api/jobs/{jobId}/process — يُستغرق ~10-15 ثانية (blocking).
 * نجاح → done مع videoUrl/downloadUrl. فشل HTTP 500 + {error} → MergerError نهائي.
 */
export async function processMergeJob(
  jobId: string,
): Promise<{ status: "done" | "failed"; videoUrl?: string; downloadUrl?: string; error?: string }> {
  const { body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 120_000);
  const st = typeof body?.status === "string" ? body.status : "";
  if (DONE_RE.test(st)) {
    return {
      status: "done",
      videoUrl: typeof body?.videoUrl === "string" ? body.videoUrl : undefined,
      downloadUrl: typeof body?.downloadUrl === "string" ? body.downloadUrl : undefined,
    };
  }
  const msg = (typeof body?.error === "string" && body.error) || "فشل تنفيذ عملية الدمج";
  throw new MergerError(500, String(msg), true);
}

/** DELETE /api/jobs/{jobId} — تنظيف اختياري */
export async function deleteMergeJob(jobId: string): Promise<void> {
  try {
    await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10_000);
  } catch {
    // التنظيف اختياري — نتجاهل الأخطاء
  }
}

/** GET /api/config — فحص جهوزية الخدمة (مهلة 4 ثوانٍ كما في المواصفة) */
export async function checkMergerHealth(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const { status } = await mergerFetch("/api/config", {}, 4_000);
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
