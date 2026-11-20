// 一画 · Vercel Serverless 入口（Node.js 运行时，兼容 Web Request 与传统 (req,res) 两种签名）
import { handleRequest } from "../shared/app.js";
import { resolveStorage } from "../shared/storage.js";

export const maxDuration = 120;

const envObj = () => ({ ...process.env });

export default async function handler(req, res) {
  // 形态一：Vercel 直接传入 Web Request
  if (req instanceof Request) {
    return await handleRequest(req, envObj(), resolveStorage(envObj()));
  }
  // 形态二：传统 Node (IncomingMessage, ServerResponse)
  try {
    const host = (req.headers && req.headers.host) || "localhost";
    const url = `https://${host}${req.url || "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (v == null) continue;
      headers.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const method = (req.method || "GET").toUpperCase();
    let body;
    if (!["GET", "HEAD"].includes(method)) {
      const chunks = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      body = Buffer.concat(chunks);
    }
    const request = new Request(url, {
      method,
      headers,
      body: body && body.length ? new Uint8Array(body) : undefined,
    });
    const response = await handleRequest(request, envObj(), resolveStorage(envObj()));
    res.statusCode = response.status;
    response.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "content-encoding") res.setHeader(k, v);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("[yihua] unhandled:", e);
    if (res && !res.writableEnded) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, code: "E_SERVER", message: "服务器内部错误，请稍后重试" }));
    }
  }
}
