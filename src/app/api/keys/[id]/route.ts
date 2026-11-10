// تعطيل/تنشيط يدوي وحذف مفتاح — حسب المعرّف
import { deleteKey, getKeyById, setKeyEnabled } from "@/lib/turso";
import { toMasked } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "طلب غير صالح — مطلوب JSON" }, { status: 400 });
  }
  const key = await getKeyById(id);
  if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });

  const action = String(body.action ?? "");
  if (action !== "disable" && action !== "enable") {
    return Response.json({ error: "الإجراء غير صالح — المسموح: disable أو enable" }, { status: 400 });
  }
  await setKeyEnabled(id, action === "enable");
  const updated = await getKeyById(id);
  return Response.json({ key: updated ? toMasked(updated) : null });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKeyById(id);
  if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return Response.json({ ok: true });
}
