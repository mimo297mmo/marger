#!/usr/bin/env python3
"""اختبار MCP كامل عبر SSE: تهيئة جلسة → استدعاء أداة مع progressToken → قراءة الأحداث الحية"""
import json
import subprocess
import sys
import time
import uuid

BASE = "http://localhost:3100/mcp"
HEADERS = ["-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream"]


def post(body, sid=None, timeout=240):
    cmd = ["curl", "-s", "-N", "--max-time", str(timeout), "-X", "POST", BASE, *HEADERS]
    if sid:
        cmd += ["-H", f"mcp-session-id: {sid}"]
    cmd += ["-d", json.dumps(body)]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)


def sse_events(proc):
    """يولّد أحداث SSE من المخرجات الحية"""
    buf = ""
    for line in proc.stdout:
        buf += line
        if line.strip() == "":
            if buf.strip():
                data_lines = [l[5:].strip() for l in buf.splitlines() if l.startswith("data:")]
                if data_lines:
                    try:
                        yield json.loads("".join(data_lines))
                    except json.JSONDecodeError:
                        pass
            buf = ""
    if buf.strip().startswith("data:"):
        try:
            yield json.loads(buf[5:])
        except Exception:
            pass


def init_session():
    out = subprocess.run(
        ["curl", "-s", "-D", "-", "-o", "/dev/null", "--max-time", "15", "-X", "POST", BASE, *HEADERS,
         "-d", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                           "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                      "clientInfo": {"name": "e2e-test", "version": "1.0"}}})],
        capture_output=True, text=True, timeout=15,
    )
    sid = None
    for line in out.stdout.splitlines():
        if line.lower().startswith("mcp-session-id:"):
            sid = line.split(":", 1)[1].strip()
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid).wait()
    return sid


def main():
    sid = init_session()
    print("SESSION:", sid)

    tool = sys.argv[1] if len(sys.argv) > 1 else "generate_image"
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {
        "prompt": "A majestic orange tabby cat wearing a tiny wizard hat, reading an ancient glowing spellbook, "
                  "cozy candlelit library background, warm magical atmosphere, highly detailed digital art",
        "wait_seconds": 120,
    }
    ptok = f"prog-{uuid.uuid4().hex[:8]}"
    body = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args, "_meta": {"progressToken": ptok}},
    }
    started = time.time()
    progress_events = 0
    final = None
    proc = post(body, sid, timeout=280)
    for msg in sse_events(proc):
        if msg.get("method") == "notifications/progress":
            progress_events += 1
            pp = msg.get("params", {})
            print(f"  [progress] {pp.get('progress')}/{pp.get('total')} — {pp.get('message')}")
        elif msg.get("id") == 3:
            final = msg
            break
    proc.wait()
    elapsed = time.time() - started

    print(f"=== elapsed: {elapsed:.1f}s, progress notifications: {progress_events}")
    if final:
        res = final.get("result", final)
        is_err = res.get("isError", False)
        texts = [c.get("text", "") for c in res.get("content", []) if c.get("type") == "text"]
        print("isError:", is_err)
        print("---RESULT TEXT---")
        print("\n".join(texts))
    else:
        print("NO FINAL RESPONSE!")


if __name__ == "__main__":
    main()
