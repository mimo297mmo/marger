// إدارة المفاتيح — GET قائمة مُقنَّعة دائمًا، POST إضافة مع رفض التكرار
// المفتاح الكامل لا يخرج من السيرفر في أي استجابة (قاعدة ذهبية 9)
import { randomUUID } from "node:crypto";
import { findDuplicateKey, insertKey, listAllKeys } from "@/lib/turso";
import { toMasked } from "@/lib/keys";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS: ProviderId[] = ["kie", "cometapi"];

export async function GET() {
  const rows = await listAllKeys();
  return Response.json({ keys: rows.map(toMasked) });
}

export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "طلب غير صالح — مطلوب JSON" }, { status: 400 });
  }

  const provider = String(body.provider ?? "").trim() as ProviderId;
  const apiKey = String(body.api_key ?? "").trim();
  const label = String(body.label ?? "").trim().slice(0, 80);

  if (!VALID_PROVIDERS.includes(provider)) {
    return Response.json({ error: "المزود غير صالح — المسموح: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: "المفتاح مطلوب" }, { status: 400 });
  }
  // رفض التكرار لنفس المزود
  if (await findDuplicateKey(provider, apiKey)) {
    return Response.json({ error: "هذا المفتاح مُضاف مسبقًا لنفس المزود — رفض التكرار" }, { status: 409 });
  }

  await insertKey({ id: randomUUID(), provider, label, api_key: apiKey });
  const rows = await listAllKeys();
  return Response.json({ keys: rows.map(toMasked) }, { status: 201 });
}
