// مسار خادم MCP — نقل Streamable HTTP وفق مواصفة MCP
// يستخدم فئات SDK الرسمية: McpServer + محوّل النقل الرسمي.
// ملاحظة معمارية: في SDK 1.32 محوّل StreamableHTTPServerTransport (نسخة Node) هو غلاف رقيق
// فوق WebStandardStreamableHTTPServerTransport عبر @hono/node-server؛ وبما أن App Router
// يتعامل أصلًا بـ Web Request/Response، نستخدم النسخة WebStandard مباشرة (نفس التنفيذ الأساسي
// الرسمي، بلا تحويل زائد Node→Web→Node).
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار حتى 240 ثانية + التوليد الفعلي — Vercel Fluid يدعم حتى 300 ثانية
export const maxDuration = 300;

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  close: () => Promise<void>;
}

// الجلسات حية في الذاكرة لكل نسخة (serverless) — العميل يعيد initialize تلقائيًا عند 404
const globalForMcp = globalThis as unknown as {
  __mcpSessions?: Map<string, McpSession>;
};
const sessions: Map<string, McpSession> = (globalForMcp.__mcpSessions ??= new Map());

function createSession(): McpSession {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, session);
      // حماية من تضخم الخريطة — نحذف الأقدم عند تجاوز 200 جلسة
      if (sessions.size > 200) {
        const oldest = sessions.keys().next().value;
        if (oldest && oldest !== id) sessions.delete(oldest);
      }
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  const server = createMcpServer();
  const session: McpSession = {
    transport,
    close: async () => {
      await server.close();
      await transport.close();
    },
  };
  void server.connect(transport);
  return session;
}

async function handleMcp(req: Request): Promise<Response> {
  // التحقق من التوثيق إن ضُبط MCP_ACCESS_TOKEN
  const token = process.env.MCP_ACCESS_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized — مطلوب Authorization: Bearer <MCP_ACCESS_TOKEN>" }, id: null },
      { status: 401 },
    );
  }

  const sid = req.headers.get("mcp-session-id");

  if (req.method === "POST") {
    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
        { status: 400 },
      );
    }

    const method = (parsedBody as { method?: string } | undefined)?.method ?? "";
    const isInitialize = method === "initialize";

    let session: McpSession | undefined;
    if (isInitialize) {
      session = createSession();
    } else if (sid) {
      session = sessions.get(sid);
    }
    if (!session) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found — أرسل initialize أولًا ثم أعد الطلب مع mcp-session-id" },
          id: null,
        },
        { status: 404 },
      );
    }

    // parsedBody مُمرَّر مسبقًا — النقل لا يقرأ الجسم مرة ثانية
    return session.transport.handleRequest(req, { parsedBody });
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (!sid) {
      return new Response("Bad Request: missing mcp-session-id header", { status: 400 });
    }
    const session = sessions.get(sid);
    if (!session) {
      return new Response("Session not found", { status: 404 });
    }
    return session.transport.handleRequest(req);
  }

  return new Response("Method not allowed", { status: 405 });
}

export { handleMcp as POST, handleMcp as GET, handleMcp as DELETE };
