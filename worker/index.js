// 一画 · Cloudflare Workers 入口
import { handleRequest } from "../shared/app.js";
import { resolveStorage } from "../shared/storage.js";

export default {
  async fetch(request, env) {
    try {
      // /admin 万一未被静态资源匹配（例如 html_handling 被改动），兜底跳转
      const url = new URL(request.url);
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return Response.redirect(new URL("/admin.html", url).toString(), 307);
      }
      return await handleRequest(request, env, resolveStorage(env));
    } catch (e) {
      console.error("[yihua] unhandled:", e);
      return new Response(
        JSON.stringify({ ok: false, code: "E_SERVER", message: "服务器内部错误，请稍后重试" }),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }
  },
};
