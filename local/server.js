// 一画 · 本地预览服务器（node local/server.js，默认使用模拟上游，不消耗真实额度）
// 真实上游调试：YIHUA_USE_REAL_UPSTREAM=1 node local/server.js
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!globalThis.crypto) {
  const { webcrypto } = await import("node:crypto");
  globalThis.crypto = webcrypto;
}

import { handleRequest } from "../shared/app.js";
import { resolveStorage } from "../shared/storage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);

const MIMES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const mock = process.env.YIHUA_USE_REAL_UPSTREAM !== "1";
const env = { ...process.env, YIHUA_MOCK_UPSTREAM: mock ? "1" : "0" };
const storage = resolveStorage(env);

function safeJoin(base, p) {
  const full = path.join(base, path.normalize(p).replace(/^([.][.][/\\])+/, ""));
  return full.startsWith(base) ? full : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);

    // API → 共享应用
    if (u.pathname.startsWith("/api/") || u.pathname === "/api") {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) headers.set(k, String(v));
      const method = req.method.toUpperCase();
      let body;
      if (!["GET", "HEAD"].includes(method)) {
        const chunks = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        body = Buffer.concat(chunks);
      }
      const request = new Request(`http://localhost:${PORT}${u.pathname}${u.search}`, {
        method,
        headers,
        body: body && body.length ? new Uint8Array(body) : undefined,
      });
      const response = await handleRequest(request, env, storage);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => {
        if (k.toLowerCase() !== "content-encoding") res.setHeader(k, v);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    // /admin → admin.html
    let p = decodeURIComponent(u.pathname);
    if (p === "/") p = "/index.html";
    if (p === "/admin") p = "/admin.html";

    const candidates = path.extname(p) ? [p] : [p, p.replace(/\/+$/, "") + ".html", p.replace(/\/+$/, "") + "/index.html"];
    let data = null;
    for (const cand of candidates) {
      const file = safeJoin(PUBLIC, cand);
      if (!file) continue;
      try {
        data = await readFile(file);
        break;
      } catch {}
    }
    if (!data) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("404 Not Found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", MIMES[path.extname(p)] || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(data);
  } catch (e) {
    console.error("[yihua-local] error:", e);
    res.statusCode = 500;
    res.end("Internal Error");
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log("  一画 · 本地预览已启动");
  console.log(`  地址:     http://localhost:${PORT}`);
  console.log(`  管理后台: http://localhost:${PORT}/admin`);
  console.log(`  上游模式: ${mock ? "模拟（不消耗真实额度）" : "真实接口"}`);
  console.log(`  存储:     ${storage.type}${storage.type === "memory" ? "（本地开发用，重启即清空）" : ""}`);
  console.log("");
});
