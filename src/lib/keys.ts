// نظام المفاتيح: الإخفاء الإلزامي + جلب التجمع بالترتيب التسلسلي الصارم
import {
  bumpKeyUsage,
  getKeyById,
  listAllKeys,
  setKeyStatus,
} from "./turso";
import type { ProviderId, MaskedKey, ApiKeyRow } from "./types";

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 — وللمفاتيح القصيرة أول 3 + ••••  */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

/** تحويل صف المفتاح إلى الشكل المُقنَّع — لا يخرج المفتاح الكامل من السيرفر في أي استجابة */
export function toMasked(k: ApiKeyRow): MaskedKey {
  const { api_key, ...rest } = k;
  return { ...rest, masked: maskKey(api_key) };
}

/**
 * تجمع المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم:
 * ORDER BY created_at ASC, id ASC — أي أول مفتاح أُضيف يُجرَّب أولًا ثم الثاني ثم الثالث…
 * هذا ترتيب مقصود وليس round-robin وليس «الأقل استخدامًا أولًا».
 * المفتاح المستنزف (exhausted) يبقى في القائمة عمدًا (قد يُشحن رصيده)؛ الاستثناء الوحيد هو disabled.
 */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  const all = await listAllKeys();
  const set = new Set<string>(providers);
  return all.filter((k) => set.has(k.provider) && k.status !== "disabled");
}

/** تسجيل استخدام المفتاح (نجاح/فشل) — عدّادات تظهر في لوحة الإدارة */
export async function recordKeyAttempt(keyId: string, ok: boolean, error?: string): Promise<void> {
  await bumpKeyUsage(keyId, ok, error);
}

/** تعليم المفتاح تلقائيًا حسب فئة الخطأ (disabled أو exhausted فقط) */
export async function applyKeyErrorClass(keyId: string, errorClass: "disabled" | "exhausted", error: string): Promise<void> {
  await setKeyStatus(keyId, errorClass, error);
}

export { getKeyById };
