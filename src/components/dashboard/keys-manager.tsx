"use client";

// مدير المفاتيح — إضافة/تعطيل/تنشيط/حذف مع عرض مُقنَّع دائمًا وعدّادات الاستخدام
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import type { MaskedKey, ProviderId } from "@/lib/types";

const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-100 text-emerald-800" },
  exhausted: { label: "مستنزف الرصيد", cls: "bg-amber-100 text-amber-800" },
  disabled: { label: "معطّل", cls: "bg-zinc-200 text-zinc-600" },
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
};

export function KeysManager({ refreshSignal }: { refreshSignal: number }) {
  const [keys, setKeys] = useState<MaskedKey[]>([]);
  const [provider, setProvider] = useState<ProviderId>("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = (await res.json()) as { keys: MaskedKey[] };
      setKeys(data.keys ?? []);
    } catch {
      // تجاهل أخطاء الاستعلام المؤقتة
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const data = (await res.json()) as { keys?: MaskedKey[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? "فشل إضافة المفتاح");
      } else {
        setKeys(data.keys ?? []);
        setApiKey("");
        setLabel("");
        setNotice("أُضيف المفتاح — سيُجرَّب أولًا في المهمة القادمة لأن التجربة تسلسلية بترتيب الإضافة.");
      }
    } catch {
      setError("تعذر الاتصال بالخادم");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(k: MaskedKey) {
    setBusy(true);
    try {
      const action = k.status === "disabled" ? "enable" : "disable";
      await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(k: MaskedKey) {
    if (!confirm(`حذف المفتاح ${k.masked}؟`)) return;
    setBusy(true);
    try {
      await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm" aria-label="مدير المفاتيح">
      <header className="flex items-center gap-2">
        <KeyRound className="size-5 text-emerald-700" />
        <h2 className="text-lg font-bold">مدير المفاتيح</h2>
      </header>

      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد
        رصيد دون توقف.
      </p>

      <form onSubmit={addKey} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            المزود
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
              className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm"
            >
              <option value="kie">kie.ai</option>
              <option value="cometapi">CometAPI</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            تسمية (اختياري)
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="مثال: حساب رئيسي"
              className="min-h-11 rounded-lg border border-zinc-300 px-3 text-sm"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium">
          المفتاح
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="ألصق مفتاح API هنا"
            className="min-h-11 rounded-lg border border-zinc-300 px-3 text-sm font-mono"
            dir="ltr"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy || !apiKey.trim()}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-800 disabled:opacity-50"
        >
          <Plus className="size-4" />
          إضافة مفتاح
        </button>
        {error && <p className="text-sm font-medium text-rose-700">{error}</p>}
        {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
      </form>

      <div className="max-h-96 overflow-y-auto rounded-xl border border-zinc-200">
        {keys.length === 0 ? (
          <p className="p-4 text-center text-sm text-zinc-500">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل.</p>
        ) : (
          <ul className="divide-y divide-zinc-200">
            {keys.map((k) => {
              const st = STATUS_STYLES[k.status] ?? STATUS_STYLES.disabled;
              return (
                <li key={k.id} className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-bold text-zinc-700" dir="ltr">
                      {PROVIDER_LABEL[k.provider] ?? k.provider}
                    </span>
                    <span className="font-mono text-sm text-zinc-800" dir="ltr">
                      {k.masked}
                    </span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${st.cls}`}>{st.label}</span>
                    {k.label && <span className="text-xs text-zinc-500">{k.label}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600">
                    <span>استخدام: {k.usage_count}</span>
                    <span className="text-emerald-700">نجاح: {k.success_count}</span>
                    <span className="text-rose-700">فشل: {k.fail_count}</span>
                    {k.last_error && (
                      <span className="max-w-full truncate text-rose-600" title={k.last_error} dir="ltr">
                        آخر خطأ: {k.last_error}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggle(k)}
                      disabled={busy}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                    >
                      <Power className="size-3.5" />
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(k)}
                      disabled={busy}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                      حذف
                    </button>
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
