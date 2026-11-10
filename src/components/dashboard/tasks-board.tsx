"use client";

// لوحة المهام — شرائح إحصائيات + قائمة تتحدث تلقائيًا كل ~5 ثوانٍ
import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Clock, ListVideo, XCircle } from "lucide-react";
import type { TaskRow, TaskStats } from "@/lib/types";

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  completed: { label: "مكتملة", cls: "bg-emerald-100 text-emerald-800" },
  failed: { label: "فاشلة", cls: "bg-rose-100 text-rose-800" },
  processing: { label: "جارية", cls: "bg-amber-100 text-amber-800" },
  pending: { label: "بالانتظار", cls: "bg-zinc-200 text-zinc-600" },
};

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  image: { label: "صورة", cls: "bg-violet-100 text-violet-800" },
  video: { label: "فيديو", cls: "bg-teal-100 text-teal-800" },
  merge: { label: "دمج", cls: "bg-orange-100 text-orange-800" },
};

function relativeTime(iso: string): string {
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "الآن";
  if (m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `قبل ${h} ساعة`;
  return `قبل ${Math.floor(h / 24)} يوم`;
}

function attemptsCount(task: TaskRow): number {
  try {
    const arr = JSON.parse(task.attempts_json ?? "[]") as unknown[];
    return arr.length;
  } catch {
    return 0;
  }
}

function urlsOf(task: TaskRow): string[] {
  try {
    const arr = JSON.parse(task.result_urls_json ?? "[]") as string[];
    return arr.filter((u) => typeof u === "string" && u.startsWith("http"));
  } catch {
    return [];
  }
}

export function TasksBoard() {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/tasks?limit=30", { cache: "no-store" });
        const data = (await res.json()) as { tasks: TaskRow[]; stats: TaskStats };
        if (alive) {
          setTasks(data.tasks ?? []);
          setStats(data.stats ?? null);
        }
      } catch {
        // تجاهل — المحاولة القادمة بعد 5 ثوانٍ
      }
    }
    void poll();
    const t = setInterval(poll, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const chips = [
    { icon: ListVideo, label: "الإجمالي", value: stats?.total ?? 0, cls: "bg-zinc-100 text-zinc-800" },
    { icon: CheckCircle2, label: "مكتملة", value: stats?.completed ?? 0, cls: "bg-emerald-50 text-emerald-800" },
    { icon: XCircle, label: "فاشلة", value: stats?.failed ?? 0, cls: "bg-rose-50 text-rose-800" },
    { icon: Clock, label: "جارية", value: stats?.active ?? 0, cls: "bg-amber-50 text-amber-800" },
  ];

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm" aria-label="لوحة المهام">
      <header className="flex items-center gap-2">
        <Activity className="size-5 text-teal-700" />
        <h2 className="text-lg font-bold">لوحة المهام</h2>
        <span className="ms-auto text-xs text-zinc-400">تحديث تلقائي كل 5 ثوانٍ</span>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {chips.map((c) => (
          <div key={c.label} className={`flex flex-col items-center rounded-xl px-3 py-3 ${c.cls}`}>
            <c.icon className="mb-1 size-5" />
            <span className="text-2xl font-extrabold tabular-nums">{c.value}</span>
            <span className="text-xs font-semibold">{c.label}</span>
          </div>
        ))}
      </div>

      <div className="max-h-96 overflow-y-auto rounded-xl border border-zinc-200">
        {tasks.length === 0 ? (
          <p className="p-4 text-center text-sm text-zinc-500">لا توجد مهام بعد — أول توليد سيظهر هنا مباشرة.</p>
        ) : (
          <ul className="divide-y divide-zinc-200">
            {tasks.map((t) => {
              const st = STATUS_BADGE[t.status] ?? STATUS_BADGE.pending;
              const tp = TYPE_BADGE[t.type] ?? TYPE_BADGE.image;
              const urls = urlsOf(t);
              return (
                <li key={t.id} className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${tp.cls}`}>{tp.label}</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${st.cls}`}>{st.label}</span>
                    <span className="font-mono text-xs text-zinc-500" dir="ltr">
                      {t.model}
                    </span>
                    <span className="ms-auto text-xs text-zinc-400">{relativeTime(t.created_at)}</span>
                  </div>
                  {t.prompt && (
                    <p className="line-clamp-2 text-sm leading-6 text-zinc-700" title={t.prompt}>
                      {t.prompt}
                    </p>
                  )}
                  {(t.status === "processing" || t.status === "pending") && (
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                      <div
                        className="h-full rounded-full bg-amber-400 transition-all duration-500"
                        style={{ width: `${Math.min(100, Math.max(3, t.progress ?? 0))}%` }}
                      />
                    </div>
                  )}
                  {t.status === "failed" && t.error_message && (
                    <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-800" dir="auto">
                      {t.error_message}
                    </p>
                  )}
                  {urls.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {urls.map((u, i) => (
                        <a
                          key={i}
                          href={u}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                          dir="ltr"
                        >
                          فتح الرابط {urls.length > 1 ? `#${i + 1}` : ""}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-xs text-zinc-400">
                    <span dir="ltr" className="font-mono">
                      {t.id.slice(0, 8)}…
                    </span>
                    <span>محاولات: {attemptsCount(t)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
