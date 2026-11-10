"use client";

// لوحة الإدارة العربية RTL — ثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { HealthBadge } from "@/components/dashboard/health-badge";
import { KeysManager } from "@/components/dashboard/keys-manager";
import { TasksBoard } from "@/components/dashboard/tasks-board";
import { ConnectionCard } from "@/components/dashboard/connection-card";

export default function DashboardPage() {
  // إشارة تحديث تُمرَّر لمدير المفاتيح عند الحاجة لإعادة قراءة فورية
  const [refreshSignal, setRefreshSignal] = useState(0);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Sparkles className="size-6 text-emerald-700" />
            <h1 className="text-xl font-extrabold">مولّد الوسائط — خادم MCP</h1>
          </div>
          <HealthBadge />
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 items-start gap-6 px-4 py-6 sm:px-6 lg:grid-cols-2 xl:grid-cols-3">
        <KeysManager refreshSignal={refreshSignal} />
        <TasksBoard />
        <ConnectionCard />
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white py-4">
        <div className="mx-auto max-w-7xl px-4 text-center text-xs leading-6 text-zinc-500 sm:px-6">
          خادم MCP لتوليد الصور والفيديو ودمج المقاطع — الروابط فقط تُخزَّن (لا ملفات على السيرفر) والتبديل بين المفاتيح
          تسلسلي تلقائي صامت.
        </div>
      </footer>
    </div>
  );
}
