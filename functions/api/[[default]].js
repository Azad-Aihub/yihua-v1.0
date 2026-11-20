// 一画 · 腾讯 EdgeOne Pages 入口（functions/api/[[default]].js → /api/*）
// 说明：EdgeOne 的 KV 命名空间在控制台绑定为全局变量（变量名 YIHUA_KV）；
//       环境变量优先从 context.env 读取，兼容以全局变量注入的情况。
import { handleRequest } from "../../shared/app.js";
import { resolveStorage, createEdgeOneStorage } from "../../shared/storage.js";

const ENV_KEYS = ["ACCESS_PASSWORD", "ADMIN_PASSWORD", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];

function collectEnv(context) {
  const env = {};
  const src = (context && context.env) || {};
  for (const k of ENV_KEYS) {
    if (src[k] !== undefined && src[k] !== null) env[k] = src[k];
    else if (typeof globalThis[k] !== "undefined" && globalThis[k] !== null) env[k] = globalThis[k];
  }
  return env;
}

export async function onRequest(context) {
  const env = collectEnv(context);
  try {
    const kv = globalThis["YIHUA_KV"];
    const storage =
      kv && typeof kv.get === "function" && typeof kv.put === "function"
        ? createEdgeOneStorage(kv)
        : resolveStorage(env);
    return await handleRequest(context.request, env, storage);
  } catch (e) {
    console.error("[yihua] unhandled:", e);
    return new Response(
      JSON.stringify({ ok: false, code: "E_SERVER", message: "服务器内部错误，请稍后重试" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
}
