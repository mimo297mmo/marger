// صياغة الردود العربية لأدوات MCP — وفق القسم 8 من المواصفة
import type { TaskRow, MediaType } from "./types";

function urlsOf(task: TaskRow): string[] {
  try {
    const arr = JSON.parse(task.result_urls_json ?? "[]") as string[];
    return arr.filter((u) => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  }
}

const TYPE_LABEL: Record<MediaType, string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

export interface ToolTextResult {
  // توقيع فهرسة مطابق لنوع CallToolResult في SDK (zod v4)
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(t: string): ToolTextResult {
  return { content: [{ type: "text", text: t }] };
}
function textError(t: string): ToolTextResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

/** صياغة نتيجة أداة من صف مهمة — مكتملة/جارية/فاشلة بالقوالب العربية المحددة */
export function toolResultFor(task: TaskRow, kind: MediaType): ToolTextResult {
  const urls = urlsOf(task);

  if (task.status === "completed" && urls.length > 0) {
    if (kind === "image") {
      return text(
        `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}`,
      );
    }
    if (kind === "video") {
      const lines = ["✅ تم توليد الفيديو بنجاح", "", ...urls.map((u) => `الرابط المباشر: ${u}`)];
      return text(lines.join("\n"));
    }
    // merge — مع التنبيه الإلزامي بصلاحية 24 ساعة
    return text(
      [
        "✅ تم دمج المقاطع بنجاح",
        "",
        ...urls.map((u) => `الرابط المباشر: ${u}`),
        "",
        "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.",
      ].join("\n"),
    );
  }

  if (task.status === "failed") {
    return textError(`❌ فشلت المهمة: ${task.error_message ?? "سبب غير معروف"}`);
  }

  // pending / processing — لا ذكر لأي تفاصيل مفاتيح أو أرصدة أبدًا
  const progressLine = task.progress > 0 ? `التقدم الحالي: ${task.progress}%\n` : "";
  return text(
    [
      `⏳ المهمة قيد المعالجة — task_id: ${task.id}`,
      progressLine,
      "تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** رد no_keys — رسالة صريحة للمستخدم بإضافة مفتاح من واجهة الإدارة */
export function noKeysResult(modelCanonical: string): ToolTextResult {
  return textError(
    `❌ لا توجد مفاتيح نشطة لخدمة ${modelCanonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
  );
}

/** صياغة قائمة الوسائط المخزنة من قاعدة البيانات مرتبة من الأحدث */
export function listMediaResult(tasks: TaskRow[]): ToolTextResult {
  if (tasks.length === 0) {
    return text("📁 لا توجد وسائط مخزنة بعد في قاعدة البيانات. جرّب generate_image أو generate_video أولًا.");
  }
  const lines: string[] = [`📁 أحدث الوسائط المخزنة (${tasks.length}):`, ""];
  tasks.forEach((t, i) => {
    const urls = urlsOf(t);
    const statusLabel =
      t.status === "completed"
        ? "✅ مكتملة"
        : t.status === "failed"
          ? "❌ فاشلة"
          : `⏳ جارية (${t.progress ?? 0}%)`;
    lines.push(
      `${i + 1}. [${TYPE_LABEL[t.type] ?? t.type}] ${t.model} — ${statusLabel} — ${t.created_at}`,
    );
    lines.push(`   task_id: ${t.id}`);
    if (urls.length > 0) {
      for (const u of urls) lines.push(`   الرابط: ${u}`);
    } else if (t.status === "failed") {
      lines.push(`   السبب: ${t.error_message ?? "غير معروف"}`);
    }
  });
  return text(lines.join("\n"));
}
