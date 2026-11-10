// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP بالكامل، متوافقة مع Vercel serverless
// لا توجد أي ملفات SQLite محلية في الإنتاج؛ المخطط يُنشأ عند أول وصول عبر CREATE TABLE IF NOT EXISTS
import { createClient, type Client, type InValue } from "@libsql/client";
import type { ApiKeyRow, AttemptEntry, MediaType, TaskProvider, TaskRow, TaskStatus, TaskStats } from "./types";

const globalForTurso = globalThis as unknown as {
  __tursoClient?: Client;
  __tursoSchemaReady?: boolean;
};

/** عميل واحد مُعاد استخدامه لكل نداءات النسخة الحالية (cold start واحد لكل instance) */
export function getDb(): Client {
  if (!globalForTurso.__tursoClient) {
    globalForTurso.__tursoClient = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    });
  }
  return globalForTurso.__tursoClient;
}

/** فحص جهوزية القاعدة — SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** إنشاء الجداول عند أول وصول على هذه النسخة (معرّف idempotent ورخيص) */
export async function ensureSchema(): Promise<void> {
  if (globalForTurso.__tursoSchemaReady) return;
  await getDb().executeMultiple(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      provider TEXT,
      provider_task_id TEXT,
      key_id TEXT,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT DEFAULT '',
      params_json TEXT DEFAULT '{}',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      result_urls_json TEXT,
      error_message TEXT,
      attempts_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT DEFAULT '',
      api_key TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      usage_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  globalForTurso.__tursoSchemaReady = true;
}

// ---------- تحويل الصفوف إلى كائنات مكتوبة ----------

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function num(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function rowToTask(r: Row): TaskRow {
  return {
    id: String(r.id),
    provider: (str(r.provider) ?? null) as TaskRow["provider"],
    provider_task_id: str(r.provider_task_id),
    key_id: str(r.key_id),
    model: String(r.model ?? ""),
    type: String(r.type ?? "image") as MediaType,
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status ?? "pending") as TaskStatus,
    progress: num(r.progress),
    result_urls_json: str(r.result_urls_json),
    error_message: str(r.error_message),
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: str(r.completed_at),
  };
}

function rowToKey(r: Row): ApiKeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider ?? "kie") as ApiKeyRow["provider"],
    label: String(r.label ?? ""),
    api_key: String(r.api_key ?? ""),
    status: String(r.status ?? "active") as ApiKeyRow["status"],
    usage_count: num(r.usage_count),
    success_count: num(r.success_count),
    fail_count: num(r.fail_count),
    last_used_at: str(r.last_used_at),
    last_checked_at: str(r.last_checked_at),
    last_error: str(r.last_error),
    created_at: String(r.created_at ?? ""),
  };
}

// ---------- عمليات المهام ----------

export interface NewTask {
  id: string;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress?: number;
  provider?: TaskProvider;
}

/** تُسجَّل المهمة في Turso قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع */
export async function insertTask(t: NewTask): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [t.id, t.provider ?? null, t.model, t.type, t.prompt, t.params_json, t.status, t.progress ?? 0] as InValue[],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  if (res.rows.length === 0) return null;
  return rowToTask(res.rows[0] as Row);
}

/** أعمدة مسموح تعديلها عبر updateTask — قائمة بيضاء تمنع حقن أسماء أعمدة */
const TASK_PATCHABLE = [
  "provider",
  "provider_task_id",
  "key_id",
  "status",
  "progress",
  "result_urls_json",
  "error_message",
] as const;

export interface TaskPatch {
  provider?: TaskProvider | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskStatus;
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
}

/**
 * تحديث جزئي لمهمة مع إضافة محاولة إلى attempts_json دائمًا عند تمريرها،
 * وضبط completed_at تلقائيًا عند الوصول لحالة completed، وتحديث updated_at دائمًا.
 */
export async function updateTask(id: string, patch: TaskPatch, attempt?: AttemptEntry): Promise<void> {
  await ensureSchema();

  let attemptsJson = "[]";
  if (attempt) {
    const current = await getTask(id);
    let list: AttemptEntry[] = [];
    try {
      list = JSON.parse(current?.attempts_json ?? "[]") as AttemptEntry[];
    } catch {
      list = [];
    }
    list.push(attempt);
    // نحفظ آخر 60 محاولة فقط حتى لا يتضخم السجل
    attemptsJson = JSON.stringify(list.slice(-60));
  }

  const sets: string[] = ["updated_at = datetime('now')"];
  const args: InValue[] = [];
  for (const col of TASK_PATCHABLE) {
    const v = patch[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      args.push(v as InValue);
    }
  }
  if (attempt) {
    sets.push("attempts_json = ?");
    args.push(attemptsJson);
  }
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
  }
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export interface TaskFilter {
  type?: MediaType;
  status?: TaskStatus;
}

/** أحدث المهام مرتبة من الأحدث مع فلترة اختيارية بالنوع/الحالة */
export async function listRecentTasks(limit = 20, filter?: TaskFilter): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter?.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter?.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  args.push(Math.min(Math.max(limit, 1), 100));
  const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const res = await getDb().execute({ sql, args });
  return res.rows.map((r) => rowToTask(r as Row));
}

/** إحصائيات لوحة المهام: إجمالي/مكتملة/فاشلة/جارية (جارية = processing + pending) */
export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const res = await getDb().execute(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END), 0) AS active
    FROM tasks
  `);
  const r = (res.rows[0] ?? {}) as Row;
  return {
    total: num(r.total),
    completed: num(r.completed),
    failed: num(r.failed),
    active: num(r.active),
  };
}

// ---------- عمليات المفاتيح ----------

export async function listAllKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const res = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows.map((r) => rowToKey(r as Row));
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const res = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  return res.rows.length ? rowToKey(res.rows[0] as Row) : null;
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const res = await getDb().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return res.rows.length > 0;
}

export async function insertKey(k: { id: string; provider: ApiKeyRow["provider"]; label: string; api_key: string }): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)",
    args: [k.id, k.provider, k.label, k.api_key],
  });
}

export async function setKeyStatus(id: string, status: ApiKeyRow["status"], lastError?: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = datetime('now') WHERE id = ?`,
    args: [status, lastError ?? null, id],
  });
}

export async function setKeyEnabled(id: string, enabled: boolean): Promise<void> {
  // التنشيط اليدوي يعيد المفتاح إلى active (يُجرَّب مجددًا بالترتيب)
  await setKeyStatus(id, enabled ? "active" : "disabled");
}

/** تحديث عدّادات المفتاح بعد كل محاولة استخدام (نجاح أو فشل) */
export async function bumpKeyUsage(id: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = COALESCE(?, last_error)
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (error ?? "").slice(0, 300), id],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

/** حذف مهام (للتنظيف بعد الاختبارات) */
export async function deleteTasksOlderThanMinutes(minutes: number): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: "DELETE FROM tasks WHERE created_at < datetime('now', ?)",
    args: [`-${minutes} minutes`],
  });
}

export async function deleteAllTestTasks(): Promise<void> {
  await ensureSchema();
  await getDb().execute("DELETE FROM tasks");
}
