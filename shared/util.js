// 一画 · 共享工具（纯 Web 标准 API，兼容 Cloudflare Workers / Vercel / EdgeOne / Node）
import { RATIOS } from "./config.js";

/* ---------------- 响应 ---------------- */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function errJson(code, message, status = 400, extra = null) {
  const body = { ok: false, code, message };
  if (extra && typeof extra === "object") Object.assign(body, extra);
  return json(body, status);
}

/** 抛出可被路由层识别的业务错误 */
export function bizError(code, message, status = 400, extra = null) {
  const e = new Error(message);
  e.__yihua = true;
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

/* ---------------- 基础类型 ---------------- */

export function str(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function toInt(v, dflt = 0) {
  const n = parseInt(str(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

export function clampInt(v, min, max, dflt = min) {
  const n = toInt(v, dflt);
  return Math.min(max, Math.max(min, n));
}

export function truncate(s, n) {
  s = str(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/* ---------------- 时间（按东八区计算“每日”） ---------------- */

const CST_OFFSET_MS = 8 * 3600 * 1000;

export function cstDate() {
  return new Date(Date.now() + CST_OFFSET_MS).toISOString().slice(0, 10);
}

export function cstHour() {
  return new Date(Date.now() + CST_OFFSET_MS).toISOString().slice(11, 13);
}

/* ---------------- 客户端 IP ---------------- */

const IP_RE = /^[0-9a-fA-F.:]{3,45}$/;

export function getClientIP(request) {
  const h = request.headers;
  const candidates = [
    h.get("cf-connecting-ip"),
    h.get("eo-connecting-ip"),
    h.get("eo-client-ip"),
    h.get("x-real-ip"),
    (h.get("x-forwarded-for") || "").split(",")[0],
  ];
  for (const c of candidates) {
    const v = str(c).trim();
    if (v && IP_RE.test(v)) return v;
  }
  return "unknown";
}

/* ---------------- 画幅尺寸 ---------------- */

export function findRatio(id) {
  return RATIOS.find((r) => r.id === id) || null;
}

/** 比例 → "宽x高" 或 "auto"；未知比例返回 null */
export function computeSize(ratioId) {
  const r = findRatio(ratioId);
  if (!r) return null;
  if (r.id === "auto") return "auto";
  return `${r.w}x${r.h}`;
}

const STD_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

export function isStdSize(s) {
  return STD_SIZES.includes(s);
}

/** 上游万一不支持所选画幅时的兜底尺寸 */
export function nearestStdSize(ratioId) {
  const r = findRatio(ratioId);
  if (!r || r.id === "auto") return "1024x1024";
  if (r.w > r.h) return "1536x1024";
  if (r.w < r.h) return "1024x1536";
  return "1024x1024";
}

/* ---------------- 哈希 / 令牌（Web Crypto） ---------------- */

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error("当前运行环境缺少 Web Crypto 支持");
  }
  return c.subtle;
}

function bytesToHex(u8) {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesToB64url(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function sha256hex(text) {
  const d = await subtle().digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(d));
}

/** 密码哈希（不存明文） */
export async function hashPassword(password) {
  return sha256hex("yihua-salt-v1|" + str(password));
}

/** 常数时间字符串比较 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 密码是否匹配（哈希比较） */
export async function passwordMatches(input, expected) {
  if (!str(input)) return false;
  const a = await hashPassword(input);
  const b = await hashPassword(expected);
  return safeEqual(a, b);
}

async function hmacB64url(message, secretHex) {
  const keyData = new Uint8Array(secretHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await subtle().importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle().sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToB64url(new Uint8Array(sig));
}

/** 签名令牌：payload(base64url).hmac —— 无需服务端存储，改密码即全体失效 */
export async function signToken(payload, secretHex) {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  return body + "." + (await hmacB64url(body, secretHex));
}

export async function verifyToken(token, secretHex, expectType) {
  try {
    const t = str(token).trim();
    const idx = t.indexOf(".");
    if (idx <= 0) return null;
    const body = t.slice(0, idx);
    const sig = t.slice(idx + 1);
    const expect = await hmacB64url(body, secretHex);
    if (!safeEqual(sig, expect)) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!payload || typeof payload !== "object") return null;
    if (expectType && payload.t !== expectType) return null;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 访客/管理令牌的签名密钥由对应密码派生：改密码后旧令牌自动失效 */
export async function tokenSecretFor(effectivePassword, scope) {
  return sha256hex(str(effectivePassword) + "|yihua-" + scope + "-v1");
}

/** 读取请求 JSON（失败返回空对象，由后续校验给出明确报错） */
export async function readJson(request) {
  try {
    const j = await request.json();
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
