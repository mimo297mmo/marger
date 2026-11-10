"use client";

// بطاقة ربط السيرفر — رابط /mcp + JSON جاهز للنسخ لثلاث مجموعات عملاء + رقائق الأدوات
import { useEffect, useState } from "react";
import { Link2, Puzzle } from "lucide-react";
import { CopyButton } from "./copy-button";
import { HealthBadge } from "./health-badge";

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى اكتمالها" },
  { name: "list_media", desc: "استرجاع الوسائط المخزنة بروابطها" },
];

type Tab = "chatgpt" | "claude" | "cursor";

export function ConnectionCard() {
  const [origin, setOrigin] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [tab, setTab] = useState<Tab>("chatgpt");

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { authRequired?: boolean }) => setAuthRequired(Boolean(d.authRequired)))
      .catch(() => {});
  }, []);

  const mcpUrl = `${origin}/mcp`;
  const headersBlock = authRequired
    ? `,\n        "headers": {\n          "Authorization": "Bearer <MCP_ACCESS_TOKEN>"`
    : "";

  const jsonFor = (t: Tab): string => {
    if (t === "claude") {
      return `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${headersBlock}
${authRequired ? "        }\n" : ""}    }
  }
}`;
    }
    // ChatGPT / GPT Agents و Cursor/Windsurf/Cline — صيغة mcp.json نفسها
    return `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${headersBlock}
${authRequired ? "        }\n" : ""}    }
  }
}`;
  };

  const tabHint: Record<Tab, string> = {
    chatgpt: "في ChatGPT: Settings → Connectors → Create → Custom MCP server — ضع الرابط في «Server URL».",
    claude: "ضع المحتوى في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.",
    cursor: "ضع المحتوى في mcp.json (Cursor / Windsurf / Cline) ثم أعد التشغيل.",
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm" aria-label="ربط السيرفر">
      <header className="flex items-center gap-2">
        <Link2 className="size-5 text-orange-700" />
        <h2 className="text-lg font-bold">ربط السيرفر</h2>
      </header>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
        <code className="truncate font-mono text-sm text-zinc-800" dir="ltr">
          {mcpUrl || "…"}
        </code>
        <CopyButton value={mcpUrl} label="نسخ الرابط" />
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="مجموعات العملاء">
        {(
          [
            ["chatgpt", "ChatGPT / GPT Agents"],
            ["claude", "Claude Desktop"],
            ["cursor", "Cursor / Windsurf / Cline"],
          ] as Array<[Tab, string]>
        ).map(([id, lbl]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            type="button"
            onClick={() => setTab(id)}
            className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              tab === id ? "bg-zinc-900 text-white" : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre
          className="max-h-72 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-left font-mono text-xs leading-5 text-emerald-300"
          dir="ltr"
        >
          {jsonFor(tab)}
        </pre>
        <div className="absolute left-3 top-3">
          <CopyButton value={jsonFor(tab)} />
        </div>
      </div>
      <p className="text-sm leading-6 text-zinc-600">{tabHint[tab]}</p>

      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-zinc-800">
          <Puzzle className="size-4" />
          الأدوات الخمس المتاحة عبر MCP
        </h3>
        <ul className="flex flex-wrap gap-2">
          {TOOLS.map((t) => (
            <li
              key={t.name}
              className="inline-flex max-w-full flex-wrap items-center gap-x-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs"
              title={t.desc}
            >
              <code className="font-mono font-bold text-zinc-800" dir="ltr">
                {t.name}
              </code>
              <span className="text-zinc-500">— {t.desc}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
        الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة
        يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
      </p>
    </section>
  );
}
