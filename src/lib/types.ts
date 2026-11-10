// الأنواع المشتركة للمشروع — تُستخدم في الخادم والواجهة (أنواع فقط بلا منطق)

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";

/** فئات تصنيف أخطاء المزودين — تُحدد سلوك التبديل التسلسلي */
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** صف مفتاح API كما هو في قاعدة Turso (api_key يُخفى دائمًا قبل الخروج للواجهة) */
export interface ApiKeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** صف مهمة توليد/دمج كما هي في قاعدة Turso */
export interface TaskRow {
  id: string;
  provider: TaskProvider | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** سجل محاولة واحدة (نجاح أو فشل) مع تصنيف الخطأ */
export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass: ErrorClass | "ok";
  error?: string;
  at: string;
}

/** مفتاح مُقنَّع — الشكل الوحيد الذي يخرج من السيرفر للواجهة أبدًا */
export interface MaskedKey extends Omit<ApiKeyRow, "api_key"> {
  masked: string;
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
}
