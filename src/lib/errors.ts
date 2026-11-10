// تصنيف أخطاء المزودين — قلب سياسة التبديل التسلسلي (القسم 4.2 من المواصفة)
import type { ErrorClass } from "./types";

/** خطأ قادم من مزود خارجي بحالة HTTP (أو code داخل الجسم) ورسالة */
export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** خطأ معطيات من المستخدم نفسه (موديل غير معروف، معاملات ناقصة…) — فشل نهائي فوري */
export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}

const AUTH_RE = /invalid api key|api key|unauthorized|forbidden|authentication/i;
const EXHAUSTED_RE = /insufficient|quota|balance|credit|out of credits|exhausted|充值/i;
const MODEL_NOT_FOUND_RE = /model not found|unsupported model|unknown model|no such model|invalid model/i;

/**
 * تصنيف موحّد لأي خطأ مزود:
 * - disabled: مفتاح مرفوض (401/403 أو رسالة توثيق) → يُعطَّل تلقائيًا ونتنقل للتالي
 * - exhausted: نفاد رصيد (402 أو رسالة رصيد — تُفحص قبل 400 لأن بعض المزودين يرسلونها بحالة 400)
 * - provider: الموديل غير مدعوم لدى هذا المزود → ننتقل للتالي
 * - params: خطأ في معطيات الطلب (400/422) → توقف فورًا، التبديل لن يحل شيئًا
 * - temporary: 429/5xx/شبكة/timeout → ننتقل للتالي والمفتاح يبقى سليمًا
 */
export function classifyProviderError(err: unknown): ErrorClass {
  const status = err instanceof ProviderError ? err.status : 0;
  const message = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403 || AUTH_RE.test(message)) return "disabled";
  // نفاد الرصيد قبل فحص 400 عمدًا — انظر جدول 4.2
  if (status === 402 || EXHAUSTED_RE.test(message)) return "exhausted";
  if (MODEL_NOT_FOUND_RE.test(message) && (status === 400 || status === 404 || status === 422)) return "provider";
  if (status === 400 || status === 422) return "params";
  // 429 و5xx والانقطاعات وأي شيء غير معروف: مؤقت
  return "temporary";
}

/**
 * كشف فشل مفتاح/رصيد في منتصف المهمة (المزود أعلن فشل المهمة نفسها برسالة تدل على مفتاح/رصيد)
 * — عندها تُعاد إنشاء نفس المهمة بنفس task_id على المفتاح التالي دون أن يشعر العميل.
 */
export function isKeyOrBalanceFailure(message: string): boolean {
  return /401|402|unauthorized|invalid.{0,16}(api )?key|forbidden|insufficient|balance|credit|quota|exhausted|充值/i.test(
    message ?? "",
  );
}

/** رسالة عربية آمنة من أي خطأ — لا تكشف أبدًا تفاصيل المفاتيح أو الأرصدة للعميل */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
