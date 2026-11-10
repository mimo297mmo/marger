# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP (Model Context Protocol)** يمنح أي عميل ذكاء اصطناعي (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK) ثلاث قدرات في أداة واحدة:

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد بالترتيب المطلوب

مع **واجهة ويب عربية RTL** لإدارة مفاتيح API ومتابعة المهام حية وإعدادات الربط الجاهزة للنسخ.

## الميزات الجوهرية

- **🔗 لا ملفات على السيرفر إطلاقًا** — تُخزَّن روابط النتائج فقط في قاعدة البيانات؛ الملفات تبقى على بنية المزود أو خدمة الدمج.
- **🔑 تبديل تسلسلي صارم للمفاتيح** — المفاتيح تُجرَّب بترتيب إضافتها بالضبط (الأول ثم الثاني ثم الثالث…) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد **دون توقف المهمة**: نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الأرصدة أبدًا**.
- **⏳ لا توقف عند نفاد كل الأرصدة** — المهمة تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة ~45 ثانية)؛ بمجرد شحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- **📡 بث تقدم حي** — أثناء نافذة الانتظار تُرسل progress notifications كل ~3 ثوانٍ (بالعربية) عند توفير `progressToken`.
- **🧩 خمسة أدوات MCP**: `generate_image` · `generate_video` · `merge_videos` · `get_task` · `list_media`.
- **🛡️ إخفاء إلزامي للمفاتيح** — لا يخرج المفتاح الكامل من السيرفر في أي استجابة أو سجل (`maskKey`).

## بنية التوليد

| الطبقة | الوصف |
|---|---|
| `src/lib/turso.ts` | عميل Turso (libSQL عبر HTTP) + `ensureSchema()` + عمليات المهام والمفاتيح |
| `src/lib/keys.ts` | `maskKey` + `getKeyPool` (ترتيب `created_at ASC, id ASC`) |
| `src/lib/errors.ts` | `classifyProviderError`: disabled / exhausted / provider / params / temporary |
| `src/lib/models.ts` | سجل MODELS مع توحيد aliases (نقاط/شرطات) وتجاوز بمتغيرات البيئة |
| `src/lib/providers/` | محوّلا المزودين: **kie.ai** (Jobs API) و **CometAPI** |
| `src/lib/runGeneration.ts` | المنسّق: التبديل التسلسلي، نافذة الانتظار، الدمج، refreshTask |
| `src/lib/merger.ts` | عميل Video Merger API v2 (بلا مفاتيح) |
| `src/lib/mcp-server.ts` | تسجيل الأدوات الخمس بصياغة عربية للنتائج |
| `src/app/mcp/route.ts` | نقطة MCP — نقل Streamable HTTP عبر SDK الرسمي |
| `src/app/page.tsx` | لوحة الإدارة العربية (مدير المفاتيح + لوحة المهام + ربط السيرفر) |

## التشغيل محليًا

```bash
bun install        # أو npm install
cp .env.example .env.local   # ثم ضع قيمك الحقيقية
npm run dev        # http://localhost:3000
```

- الواجهة: `http://localhost:3000`
- خادم MCP: `http://localhost:3000/mcp`
- فحص الصحة: `http://localhost:3000/api/health`

## متغيرات البيئة

```bash
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>
MERGER_API_BASE=https://<خدمة الدمج Video Merger API v2>   # بلا مفاتيح

# اختياري
MCP_ACCESS_TOKEN=            # إن ضُبط يُطلب Bearer token على /mcp
KIE_IMAGE_MODEL=             # تجاوز أسماء الموديلات إن لزم
KIE_VIDEO_MODEL=
COMETAPI_IMAGE_MODEL=
COMETAPI_VIDEO_MODEL=
```

> **قاعدة ذهبية:** `.env*` مستثنى من Git منذ أول commit — لا ترفع أي سر إلى المستودع أبدًا.

## إعداد Turso المجاني

```bash
turso db create <name>
turso db show <name> --url        # TURSO_DATABASE_URL
turso db tokens create <name>     # TURSO_AUTH_TOKEN
```

المخطط يُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأدوات migrations.

## النشر على Vercel

1. ارفع المستودع إلى GitHub (أو استخدم هذا المستودع مباشرة).
2. في Vercel: **Add New → Project → Import** المستودع.
3. أضف متغيرات البيئة الثلاثة في **Settings → Environment Variables**:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `MERGER_API_BASE`
   - (اختياري: `MCP_ACCESS_TOKEN`)
4. **Deploy** — كل شيء يعمل عبر HTTP (libSQL) وبدون أي ملفات محلية.

أو بزر واحد بعد ضبط المستودع:

```md
https://vercel.com/new/clone?repository-url=<رابط المستودع>&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,MERGER_API_BASE
```

## الربط من عملاء MCP

عنوان السيرفر: `<origin>/mcp` — وستجد JSON جاهزًا للنسخ لكل عميل في بطاقة «ربط السيرفر» بالواجهة:

```json
{
  "mcpServers": {
    "media-generator": {
      "url": "https://<your-app>.vercel.app/mcp"
    }
  }
}
```

- **ChatGPT:** Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
- **Claude Desktop:** نفس الصيغة مع `"type": "http"` في `claude_desktop_config.json`.
- **Cursor / Windsurf / Cline:** صيغة `mcp.json` نفسها.

## سير العمل للأداة

1. استدعِ `generate_image` أو `generate_video` — إن ظهرت روابط جاهزة فاعرضها وانتهى.
2. إن أعادت `task_id` بحالة معالجة، استدعِ `get_task` كل ~10 ثوانٍ حتى `completed` (اعرض الرابط) أو `failed`.
3. للدمج: `merge_videos` بـ `urls` (روابط مباشرة) أو `task_ids` (مهام فيديو مكتملة بالترتيب) — وتابعه بـ `get_task` بالطريقة نفسها.
4. **تنبيه:** ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.

## خدمة الدمج (Video Merger API v2)

- المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — بلا معاملات resolution/fps.
- القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد.
- كل الملفات تُحذف تلقائيًا بعد 24 ساعة.
- للاختبار المحلي دون خدمة حقيقية: `node scripts/mock-merger.js` يشغّل محاكيًا مطابقًا للمواصفة على المنفذ 3200، ثم `MERGER_API_BASE=http://localhost:3200`.

## الاختبار

```bash
npm run typecheck   # tsc --noEmit
npm run build       # next build

# اختبار MCP بـ curl (انظر قسم أمثلة في README الأصلي)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
```

سكربت اختبار e2e جاهز: `python3 scripts/mcp_e2e.py generate_image '{"prompt":"..."}'`

## ملاحظات أمنية

- المفاتيح تُخزَّن في Turso وتظهر **مُقنَّعة دائمًا** (`ABCD123••••••••WXYZ`).
- تعطيل المفتاح اليدوي هو الاستثناء الوحيد الذي يُخرجه من دوران التجربة؛ المستنزف (exhausted) يبقى في القاعدة وقد يُجرَّب مجددًا بعد شحن الرصيد.
- لا تُطبع مفاتيح كاملة في السجلات أو الردود أبدًا.
