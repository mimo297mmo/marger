// واجهة المزودات الموحّدة — يستخدمها المنسّق دون معرفة تفاصيل كل مزود
import type { ApiKeyRow } from "../types";

/** مفتاح ممرر للمحوّل (الصف الكامل — لا يخرج للعميل أبدًا) */
export type ProviderKey = ApiKeyRow;

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد معرّف المهمة لدى المزود */
  createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: ProviderKey, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(
    key: ProviderKey,
    providerTaskId: string,
  ): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}
