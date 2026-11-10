"use client";

// شارة حالة الاتصال — تستعلم /api/health وتعرض «Turso متصل» خضراء أو «غير متصل» حمراء
import { useEffect, useState } from "react";
import { Database, PlugZap, ShieldCheck } from "lucide-react";

interface Health {
  ok: boolean;
  database: string;
  merger?: { base: string | null; healthy: boolean };
  authRequired?: boolean;
}

export function HealthBadge() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as Health;
        if (alive) setHealth(data);
      } catch {
        if (alive) setHealth({ ok: false, database: "unavailable" });
      }
    }
    void poll();
    const t = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const ok = health?.ok === true;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
          ok ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
        }`}
      >
        <Database className="size-4" />
        {ok ? "Turso متصل" : "غير متصل"}
      </span>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
          health?.merger?.healthy ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
        }`}
      >
        <PlugZap className="size-4" />
        خدمة الدمج {health?.merger?.healthy ? "جاهزة" : "غير مهيأة"}
      </span>
      {health?.authRequired && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-200 px-3 py-1 text-sm font-semibold text-zinc-700">
          <ShieldCheck className="size-4" />
          /mcp محمي بـ Bearer token
        </span>
      )}
    </div>
  );
}
