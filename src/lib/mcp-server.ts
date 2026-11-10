// خادم MCP — تسجيل الأدوات الخمس بصياغات عربية للنتائج
// الأوصاف (الإنجليزية) يقرأها نموذج الذكاء الاصطناعي؛ نتائج الاستدعاء بالعربية.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { SERVER_INFO } from "./server-info";
import { startGeneration, startMerge, refreshTask } from "./runGeneration";
import { listRecentTasks } from "./turso";
import { toolResultFor, noKeysResult, listMediaResult, type ToolTextResult } from "./format";
import { ParamsError } from "./errors";
import type { MediaType, TaskRow } from "./types";

/** النص الجاهز المُرسل مع initialize — يشرح سير العمل للنموذج */
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** بناء مثيل McpServer جديد لكل جلسة (يُربط بمحوّل نقل الجلسة) */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });

  // مُرسل التقدم: يعمل فقط إذا زوّد العميل الطلب بـ _meta.progressToken
  const notifier = (extra: RequestHandlerExtra<never, never>) => {
    const progressToken = extra._meta?.progressToken;
    return async (percent: number, message: string): Promise<void> => {
      if (progressToken === undefined || progressToken === null) return;
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: percent, total: 100, message },
        } as never);
      } catch {
        // إشعارات التقدم ليست حرجة — نتجاهل أخطاءها
      }
    };
  };

  const safe = async (fn: () => Promise<ToolTextResult>): Promise<ToolTextResult> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ParamsError) return { content: [{ type: "text", text: e.message }], isError: true };
      return {
        content: [{ type: "text", text: `❌ فشلت المهمة: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  };

  // ---------- 1) generate_image ----------
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active keys). " +
        "Returns the image URL directly if it completes within the wait window; otherwise returns a task_id — " +
        "call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) =>
      safe(async () => {
        const { task, noKeys } = await startGeneration(
          "image",
          {
            model: args.model,
            prompt: args.prompt,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            background: args.background,
            output_format: args.output_format,
            wait_seconds: args.wait_seconds,
          },
          notifier(extra),
        );
        if (noKeys || !task) return noKeysResult("gpt-image-2-6/flare-text-to-image");
        return toolResultFor(task, "image");
      }),
  );

  // ---------- 2) generate_video ----------
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue in the prompt is spoken — " +
        "optional image-to-video). Videos take minutes: short wait with live progress, then a task_id — " +
        "track with get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) =>
      safe(async () => {
        const { task, noKeys } = await startGeneration(
          "video",
          {
            model: args.model,
            prompt: args.prompt,
            image_url: args.image_url,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            enable_audio: args.enable_audio,
            duration: args.duration,
            wait_seconds: args.wait_seconds,
          },
          notifier(extra),
        );
        if (noKeys || !task) return noKeysResult("grok-imagine-video-1-5-preview");
        return toolResultFor(task, "video");
      }),
  );

  // ---------- 3) merge_videos ----------
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge multiple clips into one final video in the given order. Pass 'urls' (public direct video URLs, e.g. links " +
        "returned by generate_video) or 'task_ids' (completed video generation tasks — their result URLs are merged in this " +
        "order; task_ids are resolved first, then direct urls). Merging is usually fast: short wait with live progress, then " +
        "a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only " +
        "— tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order.",
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) =>
      safe(async () => {
        const { task, error } = await startMerge(
          { urls: args.urls, task_ids: args.task_ids, wait_seconds: args.wait_seconds },
          notifier(extra),
        );
        if (error || !task) return { content: [{ type: "text", text: error ?? "❌ فشل الدمج." }], isError: true };
        return toolResultFor(task, "merge");
      }),
  );

  // ---------- 4) get_task ----------
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the " +
        "provider/merging service while in progress). Poll it every ~10 seconds; when completed you will find the result " +
        "URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) =>
      safe(async () => {
        const task: TaskRow | null = await refreshTask(args.task_id.trim());
        if (!task) {
          return {
            content: [{ type: "text", text: `❌ لا توجد مهمة بهذا المعرّف: ${args.task_id}` }],
            isError: true,
          };
        }
        return toolResultFor(task, task.type as MediaType);
      }),
  );

  // ---------- 5) list_media ----------
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Latest stored images/videos/merges with their URLs from the database (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) =>
      safe(async () => {
        const rows = await listRecentTasks(args.limit ?? 10, {
          type: args.type,
          status: args.status,
        });
        return listMediaResult(rows);
      }),
  );

  return server;
}
