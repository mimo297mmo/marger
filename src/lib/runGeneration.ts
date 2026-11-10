// منسّق التوليد: قلب المشروع
// - التبديل التسلسلي الصارم على المفاتيح (أول مفتاح أُضيف يُجرَّب أولًا)
// - «لا توقف أبدًا»: فشل مفتاح/رصيد في منتصف المهمة ⇒ إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي بصمت
// - المهمة التي تفشل على كل المفاتيح تبقى processing وتُعاد محاولتها مع كل get_task بعد تهدئة ~45 ثانية
// - نموذج الذكاء الاصطناعي لا يرى أبدًا أخطاء مفاتيح/رصيد
import {
  getTask,
  insertTask,
  updateTask,
  deleteTasksOlderThanMinutes,
} from "./turso";
import { applyKeyErrorClass, getKeyById, getKeyPool, recordKeyAttempt } from "./keys";
import { classifyProviderError, errorMessage, isKeyOrBalanceFailure, ParamsError } from "./errors";
import { resolveModel, MODELS, type ModelDef } from "./models";
import { ADAPTERS, type ProviderKey } from "./providers";
import {
  createMergeJob,
  deleteMergeJob,
  getMergeJob,
  mergerConfigured,
  processMergeJob,
  MergerError,
} from "./merger";
import type { AttemptEntry, MediaType, ProviderId, TaskRow } from "./types";

const globalForMerge = globalThis as unknown as {
  /** قفل منع تزامن نداء process مع get_task — مرة واحدة فقط لكل مهمة دمج */
  __mergeProcessInFlight?: Set<string>;
};

/** رسالة داخلية تُخزن في error_message للمعالجة الداخلية — لا تُظهر للعميل كما هي */
export const AWAITING_KEY_MSG = "بانتظار توفر مفتاح صالح… ستُعاد المحاولة تلقائيًا مع كل استعلام get_task (تهدئة ~45 ثانية).";
const RECREATE_COOLDOWN_MS = 45_000;
const POLL_INTERVAL_MS = 3_000;
const FAILOVER_EXTEND_MS = 45_000;
const TOTAL_WINDOW_CAP_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampWait(seconds: number | undefined, dflt: number): number {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(240, Math.max(0, Math.round(n)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseParams(task: TaskRow): { input?: Record<string, unknown>; processed?: boolean } {
  try {
    return JSON.parse(task.params_json ?? "{}") as { input?: Record<string, unknown>; processed?: boolean };
  } catch {
    return {};
  }
}

function firstResultUrl(task: TaskRow): string | null {
  try {
    const urls = JSON.parse(task.result_urls_json ?? "[]") as string[];
    return urls.find((u) => typeof u === "string" && u.startsWith("http")) ?? urls[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * بناء input المزود حسب النوع — أسماء الحقول من التوثيق الرسمي:
 * - kie للصور: prompt/aspect_ratio/resolution/output_format (+background عند 1K فقط)
 * - kie للفيديو: prompt/image_urls (مصفوفة!)/aspect_ratio/resolution/duration — الصوت أصلي دائمًا
 * - CometAPI للصور المتزامنة: providerModel/prompt/size
 * ملاحظة aspect_ratio=auto يُحذف (يترك للموديل).
 */
function buildProviderInput(type: MediaType, args: GenerationArgs): Record<string, unknown> {
  if (type === "image") {
    const input: Record<string, unknown> = {
      prompt: args.prompt,
      ...(args.aspect_ratio && args.aspect_ratio !== "auto" ? { aspect_ratio: args.aspect_ratio } : {}),
      ...(args.resolution ? { resolution: args.resolution } : {}),
      // background يُطبق فقط عند 1K حسب المواصفة
      ...(args.background && args.background !== "auto" && (args.resolution ?? "1K") === "1K"
        ? { background: args.background }
        : {}),
      ...(args.output_format ? { output_format: args.output_format } : {}),
      // معطيات إضافية لمحوّل CometAPI المتزامن
      providerModel: undefined,
      size: mapSizeForComet(args.aspect_ratio),
    };
    return input;
  }
  // فيديو
  return {
    prompt: args.prompt,
    ...(args.image_url ? { image_urls: [args.image_url] } : {}),
    ...(args.aspect_ratio && args.aspect_ratio !== "auto" ? { aspect_ratio: args.aspect_ratio } : {}),
    ...(args.resolution ? { resolution: args.resolution } : {}),
    ...(args.duration ? { duration: args.duration } : {}),
    // enable_audio مقبول في واجهة الأداة — الصوت أصلي دائمًا في grok-imagine (لا حقل عند المزود)
  };
}

/** تخطيط الأبعاد إلى مقاسات gpt-image المدعومة في نقطة images المتوافقة مع OpenAI */
function mapSizeForComet(aspect?: string): string | undefined {
  switch (aspect) {
    case "1:1":
      return "1024x1024";
    case "16:9":
    case "3:2":
    case "5:4":
    case "2:1":
    case "21:9":
    case "3:1":
      return "1536x1024";
    case "9:16":
    case "2:3":
    case "3:4":
    case "4:5":
    case "1:2":
    case "9:21":
    case "1:3":
      return "1024x1536";
    default:
      return undefined; // auto
  }
}

export interface GenerationArgs {
  model?: string;
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

export interface ProgressReporter {
  (percent: number, message: string): Promise<void>;
}

interface CreationOutcome {
  mode: "created" | "created-sync" | "no-key" | "failed-params";
  keyIndex?: number;
}

/** محاولة واحدة: تسجيل المحاولة + تحديث عدّادات المفتاح + تعليمه تلقائيًا عند disabled/exhausted */
async function recordFailure(taskId: string, key: ProviderKey, err: unknown): Promise<ReturnType<typeof classifyProviderError>> {
  const cls = classifyProviderError(err);
  const msg = errorMessage(err);
  await recordKeyAttempt(key.id, false, msg);
  if (cls === "disabled" || cls === "exhausted") {
    await applyKeyErrorClass(key.id, cls, msg);
  }
  const attempt: AttemptEntry = {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label,
    ok: false,
    errorClass: cls,
    error: msg.slice(0, 300),
    at: nowIso(),
  };
  await updateTask(taskId, {}, attempt);
  return cls;
}

async function recordSuccess(taskId: string, key: ProviderKey): Promise<void> {
  await recordKeyAttempt(key.id, true);
  const attempt: AttemptEntry = {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label,
    ok: true,
    errorClass: "ok",
    at: nowIso(),
  };
  await updateTask(taskId, {}, attempt);
}

/**
 * إنشاء المهمة على أول مفتاح يعمل بدءًا من مؤشر معين في تجمع المفاتيح (ترتيب تسلسلي صارم).
 * أول نجاح يربط المهمة بالمزود والمفتاح؛ فشل المعطيات يوقف كل شيء فورًا؛
 * فشل كل المفاتيح يترك المهمة processing «بانتظار توفر مفتاح صالح».
 */
async function createOnNextKey(
  taskId: string,
  model: ModelDef,
  input: Record<string, unknown>,
  pool: ProviderKey[],
  fromIndex: number,
): Promise<CreationOutcome> {
  for (let i = Math.max(0, fromIndex); i < pool.length; i++) {
    const key = pool[i];
    const adapter = ADAPTERS[key.provider];
    try {
      // صور متزامنة إن دعمها المزود (CometAPI): النتيجة تُخزَّن وتكتمل المهمة فورًا
      if (model.type === "image" && adapter.createImageSync) {
        const syncInput = { ...input, providerModel: model.providerModel[key.provider] };
        const { urls } = await adapter.createImageSync(key, syncInput);
        await recordSuccess(taskId, key);
        await updateTask(taskId, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(urls),
          error_message: null,
        });
        return { mode: "created-sync", keyIndex: i };
      }
      const { providerTaskId } = await adapter.createTask(key, model.providerModel[key.provider], input);
      await recordSuccess(taskId, key);
      await updateTask(taskId, {
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        error_message: null,
      });
      return { mode: "created", keyIndex: i };
    } catch (err) {
      const cls = await recordFailure(taskId, key, err);
      if (cls === "params") {
        // خطأ معطيات: تبديل المفاتيح لن يحل شيئًا — فشل نهائي فوري
        await updateTask(taskId, { status: "failed", error_message: `خطأ في معطيات الطلب: ${errorMessage(err)}` });
        return { mode: "failed-params" };
      }
      // disabled / exhausted / provider / temporary → جرّب المفتاح التالي فورًا دون توقف
    }
  }
  // فشل على كل المفاتيح — تبقى processing (وليست failed) وتُعاد المحاولة مع كل get_task بعد التهدئة
  await updateTask(taskId, { status: "processing", error_message: AWAITING_KEY_MSG });
  return { mode: "no-key" };
}

/**
 * التبديل الصامت في منتصف المهمة: نفس task_id على المفتاح التالي في الترتيب.
 * يعيد true إذا أعيد الإنشاء بنجاح (أو اكتملت الصورة المتزامنة).
 */
async function failoverToNextKey(task: TaskRow, model: ModelDef): Promise<boolean> {
  const params = parseParams(task);
  const input = params.input ?? {};
  const pool = await getKeyPool(model.providers);
  const idx = pool.findIndex((k) => k.id === task.key_id);
  const outcome = await createOnNextKey(task.id, model, input, pool, idx >= 0 ? idx + 1 : 0);
  return outcome.mode === "created" || outcome.mode === "created-sync";
}

/** إعادة محاولة إنشاء مهمة بلا مزود (بانتظار مفتاح) — بعد تهدئة ~45 ثانية فقط */
async function maybeRetryCreation(task: TaskRow, model: ModelDef): Promise<boolean> {
  const last = Date.parse(task.updated_at?.replace(" ", "T") + "Z");
  if (Number.isFinite(last) && Date.now() - last < RECREATE_COOLDOWN_MS) return false;
  const params = parseParams(task);
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) return false;
  const outcome = await createOnNextKey(task.id, model, params.input ?? {}, pool, 0);
  return outcome.mode === "created" || outcome.mode === "created-sync";
}

/**
 * معالجة نتيجة فحص واحدة — مشتركة بين نافذة الانتظار وrefreshTask:
 * تُحدّث Turso وتنفّذ التبديل الصامت عند فشل مفتاح/رصيد.
 */
async function handleCheckResult(
  task: TaskRow,
  checked: { status: "processing" | "completed" | "failed"; urls?: string[]; error?: string },
  model: ModelDef,
): Promise<{ task: TaskRow; switched: boolean }> {
  if (checked.status === "completed" && checked.urls?.length) {
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify(checked.urls),
      error_message: null,
    });
    return { task: (await getTask(task.id)) ?? task, switched: false };
  }
  if (checked.status === "failed") {
    const msg = checked.error ?? "فشل المزود دون تفاصيل";
    if (isKeyOrBalanceFailure(msg)) {
      // فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء بنفس task_id على المفتاح التالي بصمت
      if (task.key_id) await recordKeyAttempt(task.key_id, false, msg);
      const switched = await failoverToNextKey(task, model);
      if (!switched) {
        await updateTask(task.id, { status: "processing", error_message: AWAITING_KEY_MSG });
      }
      return { task: (await getTask(task.id)) ?? task, switched };
    }
    // فشل حقيقي (انتهاك سياسة/معطيات) — نُظهره كما هو
    await updateTask(task.id, { status: "failed", error_message: msg.slice(0, 500) });
    return { task: (await getTask(task.id)) ?? task, switched: false };
  }
  // processing — تقدير تقدم تقريبي متزايد (المزود لا يرسل نسبة دائمًا)
  const next = Math.min(95, Math.max((task.progress ?? 0) + 6, 10));
  await updateTask(task.id, { status: "processing", progress: next });
  return { task: { ...task, status: "processing", progress: next }, switched: false };
}

/** فحص واحد للمهمة من مزودها مع معالجة أخطاء الفحص نفسها (auth/رصيد أثناء الفحص) */
async function pollProviderOnce(
  task: TaskRow,
  model: ModelDef,
): Promise<{ task: TaskRow; switched: boolean }> {
  const adapter = ADAPTERS[task.provider as ProviderId];
  const key = task.key_id ? await getKeyById(task.key_id) : null;
  if (!adapter || !key) {
    // المفتاح حُذف يدويًا في منتصف المهمة → فشل تبديل: أعد الإنشاء من أول التجمع
    const switched = await failoverToNextKey(task, model);
    return { task: (await getTask(task.id)) ?? task, switched };
  }
  let checked;
  try {
    checked = await adapter.checkTask(key, task.provider_task_id!);
  } catch (err) {
    const cls = classifyProviderError(err);
    const msg = errorMessage(err);
    if (cls === "params") {
      await updateTask(task.id, { status: "failed", error_message: `خطأ في معطيات الطلب: ${msg}` });
      return { task: (await getTask(task.id)) ?? task, switched: false };
    }
    if (cls === "disabled" || cls === "exhausted") {
      await recordKeyAttempt(key.id, false, msg);
      await applyKeyErrorClass(key.id, cls, msg);
      const attempt: AttemptEntry = {
        provider: key.provider,
        keyId: key.id,
        keyLabel: key.label,
        ok: false,
        errorClass: cls,
        error: msg.slice(0, 300),
        at: nowIso(),
      };
      await updateTask(task.id, {}, attempt);
      const switched = await failoverToNextKey(task, model);
      return { task: (await getTask(task.id)) ?? task, switched };
    }
    // temporary (429/5xx/شبكة) — استمر بالاستعلام، المفتاح يبقى سليمًا
    return { task, switched: false };
  }
  return handleCheckResult(task, checked, model);
}

// ---------- البداية: إنشاء مهمة توليد ----------

export interface StartGenerationResult {
  task: TaskRow | null; // null فقط عند noKeys (لا توجد مفاتيح أصلًا)
  noKeys?: boolean;
}

/**
 * تدفق generate_image / generate_video (القسم 6):
 * 1) توحيد الموديل  2) تجمع المفاتيح (فارغ ⇒ no_keys)  3) تسجيل المهمة في Turso قبل أي نداء خارجي
 * 4) الإنشاء بالترتيب التسلسلي  5) نافذة انتظار مع بث تقدم كل ~3 ثوانٍ  6) إعادة الحالة النهائية
 */
export async function startGeneration(
  type: "image" | "video",
  args: GenerationArgs,
  notify?: ProgressReporter,
): Promise<StartGenerationResult> {
  const model = resolveModel(args.model);
  if (!model) {
    throw new ParamsError(
      `❌ موديل غير معروف: ${args.model ?? "(فارغ)"}. المتاح: ${MODELS.map((m) => m.canonical).join("، ")}`,
    );
  }
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    // رد no_keys — رسالة واضحة للمستخدم (ليست خطأ مفاتيح في منتصف مهمة)
    return { task: null, noKeys: true };
  }

  const input = buildProviderInput(type, args);
  const waitSeconds = clampWait(args.wait_seconds, type === "image" ? 90 : 25);

  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    model: model.canonical,
    type,
    prompt: args.prompt ?? "",
    params_json: JSON.stringify({ input, waitSeconds }),
    status: "pending",
    progress: 0,
  });

  const outcome = await createOnNextKey(taskId, model, input, pool, 0);
  let task = (await getTask(taskId))!;
  if (task.status === "completed") return { task }; // صورة متزامنة اكتملت خلال الإنشاء
  if (outcome.mode === "no-key" || outcome.mode === "failed-params") {
    return { task };
  }

  // نافذة الانتظار مع بث التقدم
  let deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    task = (await getTask(taskId))!;
    if (task.status === "completed" || task.status === "failed") return { task };
    if (!task.provider || !task.provider_task_id) {
      // لم يُنشأ بعد (بانتظار مفتاح) — أعد المحاولة بعد التهدئة
      const retried = await maybeRetryCreation(task, model);
      if (retried) {
        deadline = Math.min(deadline + FAILOVER_EXTEND_MS, Date.now() + TOTAL_WINDOW_CAP_MS);
        continue;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const { task: updated, switched } = await pollProviderOnce(task, model);
    task = updated;
    if (task.status === "completed" || task.status === "failed") return { task };
    if (switched) {
      // التبديل الصامت يحتاج وقتًا إضافيًا — نمدد النافذة بحد أقصى إجمالي
      deadline = Math.min(deadline + FAILOVER_EXTEND_MS, Date.now() + TOTAL_WINDOW_CAP_MS);
    }
    await notify?.(task.progress ?? 0, `قيد التوليد… ${task.progress ?? 0}%`);
    await sleep(POLL_INTERVAL_MS);
  }
  // انتهت النافذة والنتيجة لم تظهر → processing مع task_id والعميل يتابع بـ get_task
  return { task: (await getTask(taskId)) ?? task };
}

// ---------- التتبع: get_task ----------

/** refreshTask: تحديث حي للمهمة من المزود/الخدمة مع نفس منطق التبديل وإعادة المحاولة */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.type === "merge") return refreshMergeTask(task);
  if (task.status === "completed" || task.status === "failed") return task;

  const model = resolveModel(task.model);
  if (!model) return task;

  if (!task.provider || !task.provider_task_id) {
    await maybeRetryCreation(task, model);
    return (await getTask(taskId)) ?? task;
  }
  await pollProviderOnce(task, model);
  return (await getTask(taskId)) ?? task;
}

// ---------- الدمج: runMerge + refreshMergeTask ----------

export interface MergeOutcome {
  task: TaskRow | null;
  error?: string; // رسالة عربية جاهزة للعرض عند رفض الطلب قبل إنشاء المهمة
}

/** تحقق صارم من رابط الفيديو: http/https مباشر وعام */
function validatePublicHttpUrl(u: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return "ليست رابطًا صالحًا";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "يجب أن يكون http/https";
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local")) return "نطاق غير عام";
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return "نطاق داخلي/خاص";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "نطاق داخلي/خاص";
  if (host === "[::1]" || host.startsWith("fd") || host.startsWith("fe80")) return "نطاق داخلي/خاص";
  return null;
}

/** إطلاق process خلفيًا وبمرة واحدة فقط — محمي بقفل في الذاكرة حتى لا يتزامن مع get_task */
async function ensureProcessFired(jobId: string, taskId: string): Promise<void> {
  const inflight = (globalForMerge.__mergeProcessInFlight ??= new Set<string>());
  if (inflight.has(jobId)) return;
  inflight.add(jobId);
  void (async () => {
    try {
      const res = await processMergeJob(jobId);
      if (res.status === "done") {
        const urls = [res.videoUrl, res.downloadUrl].filter((u): u is string => Boolean(u));
        if (urls.length > 0) {
          await updateTask(taskId, {
            status: "completed",
            progress: 100,
            result_urls_json: JSON.stringify(urls),
            error_message: null,
          });
        }
      }
    } catch (e) {
      if (e instanceof MergerError && e.final) {
        // فشل حتمي معلَن من الخدمة (مثل Download failed (HTTP 403)) — لا إعادة محاولة
        await updateTask(taskId, { status: "failed", error_message: `فشل الدمج نهائيًا: ${e.message}` });
      }
      // أخطاء شبكتنا مؤقتة — الاستعلام GET يستمر حتى انتهاء النافذة
    } finally {
      inflight.delete(jobId);
    }
  })();
}

/** تحديث مهمة دمج واحدة من خدمة الدمج (مع إطلاق process إن لم يُنفَّذ بعد) */
async function pollMergeOnce(task: TaskRow): Promise<TaskRow> {
  // الحالات النهائية لا تُلمس — فشل حتمي مسجّل يبقى فاشلًا (لا إعادة محاولة)
  if (task.status === "completed" || task.status === "failed") return task;
  if (!mergerConfigured()) return task;
  const jobId = task.provider_task_id;
  if (!jobId) return task;

  let st;
  try {
    st = await getMergeJob(jobId);
  } catch (e) {
    if (e instanceof MergerError && e.final) {
      // أخطاء الخدمة المعلنة = فشل نهائي فوري (باستثناء 404 المعالج داخل getMergeJob)
      await updateTask(task.id, { status: "failed", error_message: `فشل الدمج: ${e.message}` });
      return (await getTask(task.id)) ?? task;
    }
    // مؤقت — استمر بالاستعلام
    return task;
  }

  if (st.notFound) {
    // 404 ⇒ حُذفت أو انتهت صلاحيتها (24 ساعة)
    await updateTask(task.id, {
      status: "failed",
      error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
    });
    return (await getTask(task.id)) ?? task;
  }

  if (st.status === "completed") {
    // فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط الرابط من jobId
    const constructed = `${(process.env.MERGER_API_BASE || "").replace(/\/+$/, "")}/api/jobs/${jobId}/video`;
    const urls = [st.videoUrl, st.downloadUrl, constructed].filter(
      (u): u is string => Boolean(u && u.startsWith("http")),
    );
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify(urls.length ? urls : [constructed]),
      error_message: null,
    });
    return (await getTask(task.id)) ?? task;
  }

  if (st.status === "failed") {
    await updateTask(task.id, { status: "failed", error_message: `فشل الدمج: ${st.error ?? "بدون تفاصيل"}` });
    return (await getTask(task.id)) ?? task;
  }

  // queued/processing — أطلق process مرة واحدة إن لم يُنفَّذ بعد
  const params = parseParams(task);
  if (!params.processed) {
    await ensureProcessFired(jobId, task.id);
  }
  const progress = Math.max(task.progress ?? 0, Math.min(95, Math.round(st.progress || task.progress || 10)));
  await updateTask(task.id, { status: "processing", progress });
  return { ...task, status: "processing", progress };
}

/** refreshMergeTask لمهام الدمج الجارية — تُستدعى من get_task */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  if (task.status === "completed" || task.status === "failed") return task;
  if (!mergerConfigured()) return task;
  if (!task.provider_task_id) {
    // لا يوجد jobId (فشل الإنشاء قبل تخزينه) — فشل نهائي
    await updateTask(task.id, {
      status: "failed",
      error_message: task.error_message ?? "فشل إنشاء مهمة الدمج لدى الخدمة",
    });
    return (await getTask(task.id)) ?? task;
  }
  return pollMergeOnce(task);
}

/**
 * تدفق merge_videos (القسم 7.3):
 * - حلّ task_ids من قاعدة البيانات بالترتيب ثم أضف urls المباشرة بنفس ترتيبها
 * - تحقق صارم: ≥2 و≤10 وكلها http/https مباشرة وعامة
 * - سجّل المهمة أولًا ثم POST /api/jobs ثم process خلفيًا مرة واحدة ثم استعلام كل 3 ثوانٍ
 */
export async function startMerge(
  args: { urls?: string[]; task_ids?: string[]; wait_seconds?: number },
  notify?: ProgressReporter,
): Promise<MergeOutcome> {
  // تحقق المدخلات أولًا (يُختبر حتى لو لم تُهيأ خدمة الدمج بعد)
  const resolved: string[] = [];
  const problems: string[] = [];
  for (const id of args.task_ids ?? []) {
    const t = await getTask(String(id).trim());
    const url = t && t.status === "completed" && t.type === "video" ? firstResultUrl(t) : null;
    if (!url) {
      problems.push(
        `- task_id ${id}: ${t ? (t.type !== "video" ? `ليست مهمة فيديو (${t.type})` : `الحالة ${t.status}${t.result_urls_json ? "" : " (لا يوجد رابط نتيجة)"}`) : "غير موجودة في قاعدة البيانات"}`,
      );
    } else {
      resolved.push(url);
    }
  }
  const direct = (args.urls ?? []).map((u) => String(u).trim()).filter(Boolean);
  const all = [...resolved, ...direct];

  if (all.length < 2) {
    return {
      task: null,
      error:
        "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." +
        (problems.length ? `\nتفاصيل المعرّفات غير الصالحة:\n${problems.join("\n")}` : ""),
    };
  }
  if (all.length > 10) {
    return { task: null, error: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  for (const u of all) {
    const bad = validatePublicHttpUrl(u);
    if (bad) return { task: null, error: `❌ رابط غير صالح للدمج: ${u} — ${bad}. مرّر روابط فيديو مباشرة عامة.` };
  }

  // بعد نجاح تحقق المدخلات نتحقق من تهيئة خدمة الدمج
  if (!mergerConfigured()) {
    return {
      task: null,
      error: "❌ خدمة الدمج غير مهيأة — اضبط MERGER_API_BASE في متغيرات البيئة ثم أعد المحاولة.",
    };
  }

  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    params_json: JSON.stringify({ urls: all, processed: false }),
    status: "processing",
    progress: 3,
  });

  try {
    const job = await createMergeJob(all);
    await updateTask(taskId, { provider_task_id: job.jobId });
  } catch (e) {
    const msg = e instanceof MergerError && e.final ? e.message : errorMessage(e);
    await updateTask(taskId, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${msg}` });
    return { task: (await getTask(taskId))! };
  }

  const task0 = (await getTask(taskId))!;
  await pollMergeOnce(task0); // يطلق process خلفيًا فورًا

  const wait = clampWait(args.wait_seconds ?? 60, 60);
  let deadline = Date.now() + wait * 1000;
  let task = task0;
  while (Date.now() < deadline) {
    task = await pollMergeOnce(await getTask(taskId).then((t) => t ?? task));
    if (task.status === "completed" || task.status === "failed") return { task };
    await notify?.(task.progress ?? 0, `قيد الدمج… ${task.progress ?? 0}%`);
    await sleep(POLL_INTERVAL_MS);
  }
  return { task: (await getTask(taskId)) ?? task };
}

/** تنظيف مهام قديمة أثناء المرور (اختياري — تستدعيه لوحة الإدارة) */
export async function cleanupOldTasks(minutes = 24 * 60): Promise<number> {
  const before = (await getTask("nonexistent")) ? 1 : 0; // touch schema
  void before;
  await deleteTasksOlderThanMinutes(minutes);
  return 0;
}

export { deleteMergeJob };
