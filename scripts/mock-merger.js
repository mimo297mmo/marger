#!/usr/bin/env node
// خدمة دمج محاكية (Mock) مطابقة لمواصفة Video Merger API v2 — للاختبار المحلي فقط
// تُحاكي: POST /api/jobs، POST /api/jobs/{id}/process (blocking ~3 ثوانٍ)،
// GET /api/jobs/{id} (progress كسري 0..1!)، DELETE، GET /api/config
// وتخدم ملف MP4 حقيقيًا على /api/jobs/{id}/video
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const PORT = 3200;
const jobs = new Map(); // id -> { status, progress, createdAt, sourceUrl, error }
// مقطع MP4 حقيقي صغير يُستخدم كناتج الدمج (يُنزَّل مرة عند أول تشغيل)
let demoMp4 = null;
const DEMO_URL = "https://www.w3schools.com/html/mov_bbb.mp4";

function ensureDemo() {
  if (demoMp4) return;
  try {
    const p = "/tmp/mock-merger-demo.mp4";
    if (!fs.existsSync(p)) {
      const { execSync } = require("child_process");
      execSync(`curl -s --max-time 30 -o ${p} ${DEMO_URL}`);
    }
    demoMp4 = fs.readFileSync(p);
  } catch (e) {
    demoMp4 = null;
  }
}

function send(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/config") {
    return send(res, 200, {
      maxClips: 10,
      maxSourceSizeMB: 200,
      maxOutputSizeMB: 150,
      maxTotalDurationSec: 600,
      retentionHours: 24,
    });
  }

  if (req.method === "POST" && path === "/api/jobs") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { videos } = JSON.parse(body);
        if (!Array.isArray(videos) || videos.length < 2 || videos.length > 10) {
          return send(res, 400, { error: "videos must be an array of 2..10 direct mp4 urls" });
        }
        for (const v of videos) {
          if (!/^https?:\/\//.test(v)) return send(res, 400, { error: `invalid video url: ${v}` });
        }
        const id = crypto.randomBytes(5).toString("hex");
        jobs.set(id, { status: "queued", progress: 0, createdAt: Date.now(), sourceUrl: videos[0], videos });
        console.log(`[mock-merger] job ${id} created with ${videos.length} videos`);
        return send(res, 200, {
          jobId: id,
          status: "queued",
          statusUrl: `http://localhost:${PORT}/api/jobs/${id}`,
          processUrl: `http://localhost:${PORT}/api/jobs/${id}/process`,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        });
      } catch {
        return send(res, 400, { error: "bad json" });
      }
    });
    return;
  }

  // POST /api/jobs/{id}/process — blocking ~3s ثم done
  const processMatch = path.match(/^\/api\/jobs\/([a-f0-9]+)\/process$/);
  if (req.method === "POST" && processMatch) {
    const id = processMatch[1];
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: "job not found" });
    // سيناريو فشل خاص للتجربة: رابط المصدر يحتوي "reject-download"
    if (job.videos && job.videos.some((v) => v.includes("reject-download"))) {
      job.status = "error";
      job.error = "Download failed (HTTP 403)";
      console.log(`[mock-merger] job ${id} process failed (final)`);
      return send(res, 500, { error: "Download failed (HTTP 403)" });
    }
    setTimeout(() => {
      job.status = "done";
      job.progress = 1;
      job.videoUrl = `http://localhost:${PORT}/${id}/video`;
      job.downloadUrl = `http://localhost:${PORT}/api/jobs/${id}/video?download=1`;
      console.log(`[mock-merger] job ${id} processed (done)`);
      send(res, 200, {
        status: "done",
        videoUrl: job.videoUrl,
        downloadUrl: job.downloadUrl,
        size: demoMp4 ? demoMp4.length : 1234567,
        duration: 10.0,
        resolution: "640x360",
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
    }, 3000);
    return;
  }

  // GET /api/jobs/{id} — progress كسري 0..1 عمدًا لاختبار التحليل الدفاعي
  const getMatch = path.match(/^\/api\/jobs\/([a-f0-9]+)$/);
  if (req.method === "GET" && getMatch) {
    const id = getMatch[1];
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: "job not found" });
    // مهمة فاشلة: الجسم فيه error بلا حقل status — عقدة فشل نهائي
    if (job.status === "error") {
      return send(res, 200, JSON.stringify({ error: job.error }));
    }
    if (job.status === "queued" || job.status === "processing") {
      job.progress = Math.min(1, (job.progress || 0) + 0.25);
      if (job.progress >= 1) job.status = "done";
    }
    const body = {
      status: job.status,
      progress: job.status === "done" ? 1 : job.progress,
    };
    if (job.status === "done") {
      body.videoUrl = job.videoUrl;
      body.downloadUrl = job.downloadUrl;
    }
    return send(res, 200, body);
  }

  // GET /{id}/video أو /api/jobs/{id}/video — يخدم MP4 حقيقيًا
  const videoMatch = path.match(/^\/(?:api\/jobs\/)?([a-f0-9]+)\/video$/);
  if (req.method === "GET" && videoMatch) {
    const id = videoMatch[1];
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: "job not found" });
    ensureDemo();
    if (!demoMp4) return send(res, 500, { error: "demo file missing" });
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": demoMp4.length });
    return res.end(req.method === "HEAD" ? undefined : demoMp4);
  }

  if (req.method === "DELETE" && /^\/api\/jobs\/([a-f0-9]+)$/.test(path)) {
    const id = path.split("/")[3];
    jobs.delete(id);
    return send(res, 200, { deleted: true });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`[mock-merger] listening on :${PORT}`));
