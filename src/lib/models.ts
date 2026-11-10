// سجل الموديلات — الموحد للأسماء بين عميل MCP والمزودين
// الأسماء قابلة للتجاوز بمتغيرات البيئة: KIE_IMAGE_MODEL, KIE_VIDEO_MODEL, COMETAPI_IMAGE_MODEL, COMETAPI_VIDEO_MODEL
import type { MediaType, ProviderId } from "./types";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب التسلسلي
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسَل لكل مزود
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: KIE_IMAGE_MODEL,
    aliases: [
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
      "gpt-image-2.6-flare-text-to-image",
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: KIE_VIDEO_MODEL,
    aliases: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

/** توليد صيغ مطابقة: الأصل + استبدال النقاط بشرطات + استبدال الشرطات بنقاط (بتجانس الأحرف) */
function variants(name: string): string[] {
  const n = name.trim().toLowerCase();
  return [n, n.replace(/\./g, "-"), n.replace(/-/g, ".")];
}

/**
 * توحيد اسم الموديل عبر aliases — يقبل الصيغ بالنقاط أو الشرطات ويعيد التعريف الرسمي.
 * يعيد null إن كان غير معروف → خطأ معطيات فوري.
 */
export function resolveModel(name?: string | null): ModelDef | null {
  if (!name) return null;
  const cands = variants(name);
  for (const m of MODELS) {
    const accepted = [m.canonical, ...m.aliases].flatMap(variants);
    if (cands.some((c) => accepted.includes(c))) return m;
  }
  return null;
}

/** ملخص الموديلات لاستجابة /api/health */
export function modelsSummary(): Array<{ canonical: string; type: MediaType; providers: ProviderId[] }> {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
