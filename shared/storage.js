// 一画 · 存储适配器
// 统一接口: get(key) / put(key, value, ttlSec) / del(key) / incr(key, ttlSec)
// 支持三种后端：Cloudflare KV（含 EdgeOne KV 兼容封装）、Upstash Redis（REST）、内存兜底

function toInt(v, dflt = 0) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : dflt;
}

/* ---------------- 内存（兜底 / 本地开发） ---------------- */

export function createMemoryStorage() {
  const map = new Map();
  return {
    type: "memory",
    async get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (e.exp && Date.now() > e.exp) {
        map.delete(key);
        return null;
      }
      return e.v;
    },
    async put(key, value, ttlSec = 0) {
      map.set(key, { v: String(value), exp: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
    },
    async del(key) {
      map.delete(key);
    },
    async incr(key, ttlSec = 0) {
      const n = toInt(await this.get(key)) + 1;
      await this.put(key, String(n), ttlSec);
      return n;
    },
  };
}

/* ---------------- Cloudflare KV 及同形 KV（get/put/delete 签名一致） ---------------- */

export function createKvLikeStorage(kv, label = "cloudflare-kv") {
  return {
    type: label,
    async get(key) {
      return await kv.get(key);
    },
    async put(key, value, ttlSec = 0) {
      if (ttlSec > 0) {
        await kv.put(key, String(value), { expirationTtl: Math.max(60, ttlSec) });
      } else {
        await kv.put(key, String(value));
      }
    },
    async del(key) {
      await kv.delete(key);
    },
    async incr(key, ttlSec = 0) {
      // KV 无原子自增；本场景并发极低，读改写足够（误差最多 1 张）
      const n = toInt(await kv.get(key)) + 1;
      await this.put(key, String(n), ttlSec);
      return n;
    },
  };
}

/* ---------------- EdgeOne Pages KV ----------------
 * EdgeOne 的 KV 以全局变量注入（绑定时的变量名），put 不支持 TTL，
 * 且 key 仅允许字母、数字、下划线 —— 此处对 key 做十六进制转义，
 * 并在 put 时把 TTL 记录进值内，读取时检查过期（惰性过期）。
 * ------------------------------------------------ */

function eoEncode(key) {
  let out = "";
  for (const ch of String(key)) {
    if (/[A-Za-z0-9_]/.test(ch)) out += ch;
    else out += "x" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  }
  return out;
}

export function createEdgeOneStorage(kv) {
  async function getRaw(key) {
    const raw = await kv.get(eoEncode(key));
    if (raw == null) return null;
    // 带过期包装: {"$exp":ms,"v":...}
    if (typeof raw === "string" && raw.startsWith('{"$exp":')) {
      try {
        const obj = JSON.parse(raw);
        if (obj.$exp && Date.now() > obj.$exp) {
          kv.delete(eoEncode(key)).catch(() => {});
          return null;
        }
        return obj.v;
      } catch {
        return raw;
      }
    }
    return raw;
  }
  return {
    type: "edgeone-kv",
    async get(key) {
      return await getRaw(key);
    },
    async put(key, value, ttlSec = 0) {
      const v = String(value);
      if (ttlSec > 0) {
        await kv.put(eoEncode(key), JSON.stringify({ $exp: Date.now() + ttlSec * 1000, v }));
      } else {
        await kv.put(eoEncode(key), v);
      }
    },
    async del(key) {
      await kv.delete(eoEncode(key));
    },
    async incr(key, ttlSec = 0) {
      const n = toInt(await getRaw(key)) + 1;
      await this.put(key, String(n), ttlSec);
      return n;
    },
  };
}

/* ---------------- Upstash Redis（REST，免费额度高，适合 Vercel） ---------------- */

export function createUpstashStorage(url, token) {
  const base = String(url).replace(/\/+$/, "");
  async function call(path) {
    const r = await fetch(base + path, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    if (!r.ok) throw new Error("Upstash HTTP " + r.status);
    const j = await r.json();
    return j && "result" in j ? j.result : null;
  }
  return {
    type: "upstash-redis",
    async get(key) {
      return await call(`/get/${encodeURIComponent(key)}`);
    },
    async put(key, value, ttlSec = 0) {
      const k = encodeURIComponent(key);
      const v = encodeURIComponent(String(value));
      await call(ttlSec > 0 ? `/set/${k}/${v}/ex/${ttlSec}` : `/set/${k}/${v}`);
    },
    async del(key) {
      await call(`/del/${encodeURIComponent(key)}`);
    },
    async incr(key, ttlSec = 0) {
      // INCR 原子自增；首次写入时补 TTL
      const n = await call(`/incr/${encodeURIComponent(key)}`);
      if (n === 1 && ttlSec > 0) {
        try {
          await call(`/expire/${encodeURIComponent(key)}/${ttlSec}`);
        } catch {}
      }
      return n;
    },
  };
}

/* ---------------- 解析：按环境自动选择存储 ---------------- */

export function resolveStorage(env = {}) {
  try {
    // 1. Cloudflare Workers / 通用 KV 绑定（变量名 YIHUA_KV）
    const kv = env.YIHUA_KV;
    if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
      return createKvLikeStorage(kv, "cloudflare-kv");
    }
    // 2. Upstash Redis（Vercel / 无 KV 绑定的平台）
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      return createUpstashStorage(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
    }
  } catch (e) {
    try {
      console.error("[yihua] 存储初始化失败，回退为内存模式:", e && e.message);
    } catch {}
  }
  return createMemoryStorage();
}
