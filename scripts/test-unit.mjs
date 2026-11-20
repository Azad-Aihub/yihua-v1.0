// 一画 · 单元测试（node scripts/test-unit.mjs）
// 覆盖：存储适配器、令牌、尺寸映射、公开接口、鉴权、限额、多通道、图生图、管理后台、密钥不泄露
import assert from "node:assert/strict";
import { handleRequest } from "../shared/app.js";
import { createMemoryStorage, createKvLikeStorage, createUpstashStorage, createEdgeOneStorage, resolveStorage } from "../shared/storage.js";
import { signToken, verifyToken, sha256hex, computeSize, nearestStdSize, isStdSize } from "../shared/util.js";

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    failures.push({ name, e });
    console.log("  ✗ " + name + "  →  " + (e && e.message));
  }
}

const MOCK_ENV = { YIHUA_MOCK_UPSTREAM: "1" };

async function call(path, { method = "GET", body = null, headers = {}, env = MOCK_ENV, storage = null, ip = "203.0.113.10" } = {}) {
  const h = new Headers(headers);
  h.set("x-forwarded-for", ip);
  h.set("cf-connecting-ip", ip);
  let init = { method, headers: h };
  if (body !== null && !(body instanceof FormData)) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    init.body = body;
  }
  const req = new Request("https://yihua.test" + path, init);
  const st = storage || createMemoryStorage();
  const res = await handleRequest(req, env, st);
  const j = await res.json().catch(() => null);
  return { status: res.status, j, res, storage: st };
}

console.log("\n== 工具函数 ==");

await test("尺寸映射：各比例正确", async () => {
  assert.equal(computeSize("1:1"), "1024x1024");
  assert.equal(computeSize("2:3"), "1024x1536");
  assert.equal(computeSize("3:2"), "1536x1024");
  assert.equal(computeSize("4:3"), "1536x1152");
  assert.equal(computeSize("3:4"), "1152x1536");
  assert.equal(computeSize("16:9"), "1536x864");
  assert.equal(computeSize("9:16"), "864x1536");
  assert.equal(computeSize("21:9"), "1792x768");
  assert.equal(computeSize("9:21"), "768x1792");
  assert.equal(computeSize("auto"), "auto");
  assert.equal(computeSize("99:1"), null);
  assert.equal(isStdSize("1024x1024"), true);
  assert.equal(isStdSize("1792x768"), false);
  assert.equal(nearestStdSize("21:9"), "1536x1024");
  assert.equal(nearestStdSize("9:21"), "1024x1536");
  assert.equal(nearestStdSize("auto"), "1024x1024");
});

await test("令牌：签名/校验/防篡改/防过期", async () => {
  const secret = await sha256hex("unit-secret");
  const tok = await signToken({ t: "v", exp: Date.now() + 60000 }, secret);
  assert.ok(await verifyToken(tok, secret, "v"));
  assert.equal(await verifyToken(tok + "x", secret, "v"), null);
  assert.equal(await verifyToken(tok, await sha256hex("other"), "v"), null);
  const expired = await signToken({ t: "v", exp: Date.now() - 1000 }, secret);
  assert.equal(await verifyToken(expired, secret, "v"), null);
  const adminTok = await signToken({ t: "a", exp: Date.now() + 60000 }, secret);
  assert.equal(await verifyToken(adminTok, secret, "v"), null);
});

await test("存储：内存适配器 incr 与 TTL", async () => {
  const s = createMemoryStorage();
  assert.equal(await s.incr("c", 60), 1);
  assert.equal(await s.incr("c", 60), 2);
  await s.put("k", "v", 1);
  assert.equal(await s.get("k"), "v");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await s.get("k"), null);
});

await test("存储：Cloudflare KV 适配器（含 TTL 下限）", async () => {
  const calls = [];
  const fakeKV = {
    async get(k) { calls.push(["get", k]); return (this.d && this.d.get(k)) || null; },
    async put(k, v, opts) { calls.push(["put", k, v, opts]); this.d = (this.d || new Map()).set(k, v); },
    async delete(k) { this.d.delete(k); },
    d: new Map(),
  };
  const s = createKvLikeStorage(fakeKV);
  assert.equal(await s.get("x"), null);
  await s.put("x", "1", 5); // ttl<60 应被钳制为 60
  const putCall = calls.find((c) => c[0] === "put");
  assert.equal(putCall[3].expirationTtl, 60);
  assert.equal(await s.get("x"), "1");
  await s.del("x");
  assert.equal(await s.get("x"), null);
});

await test("存储：Upstash REST 适配器（INCR/EXPIRE/SET）", async () => {
  const paths = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname;
    paths.push(p);
    let result = null;
    if (p.startsWith("/incr/counter")) { result = 1; }
    else if (p.startsWith("/expire/counter")) { result = 1; }
    else if (p.startsWith("/get/counter")) { result = "1"; }
    else if (p.startsWith("/set/")) { result = "OK"; }
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  try {
    const s = createUpstashStorage("https://db.upstash.io/", "tok");
    assert.equal(await s.incr("counter", 172800), 1);
    assert.ok(paths.some((p) => p === "/incr/counter"), "INCR 路径");
    assert.ok(paths.some((p) => p === "/expire/counter/172800"), "首次 INCR 后补 TTL");
    assert.equal(await s.get("counter"), "1");
    await s.put("cfg", JSON.stringify({ a: 1 }), 0);
    assert.ok(paths.some((p) => p.startsWith("/set/cfg/")), "SET 路径");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("存储：EdgeOne KV 适配器 key 转义与惰性过期", async () => {
  const d = new Map();
  const fakeKV = {
    async get(k) { return d.get(k) ?? null; },
    async put(k, v) {
      if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error("EdgeOne key 含非法字符: " + k);
      d.set(k, v);
    },
    async delete(k) { d.delete(k); },
  };
  const s = createEdgeOneStorage(fakeKV);
  await s.put("rl:2026-11-20:1.2.3.4", "7", 172800);
  assert.equal(await s.get("rl:2026-11-20:1.2.3.4"), "7");
  const key = [...d.keys()][0];
  assert.match(key, /^[A-Za-z0-9_]+$/);
  await s.put("tmp", "v", 1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await s.get("tmp"), null);
  assert.equal(await s.incr("n", 60), 1);
});

await test("存储：resolveStorage 优先级", async () => {
  const kvLike = { get: () => null, put: () => {}, delete: () => {} };
  assert.equal(resolveStorage({ YIHUA_KV: kvLike }).type, "cloudflare-kv");
  assert.equal(resolveStorage({ UPSTASH_REDIS_REST_URL: "https://x", UPSTASH_REDIS_REST_TOKEN: "t" }).type, "upstash-redis");
  assert.equal(resolveStorage({}).type, "memory");
});

console.log("\n== 公开接口 ==");

await test("健康检查", async () => {
  const { status, j } = await call("/api/health");
  assert.equal(status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.storage, "memory");
});

await test("配置接口：结构完整且不泄露任何密钥", async () => {
  const { j } = await call("/api/config");
  assert.equal(j.ok, true);
  assert.equal(j.ratios.length, 10);
  assert.equal(j.channels.length, 1);
  assert.equal(j.channels[0].models.length, 7);
  assert.equal(j.usage.limit, 10);
  const raw = JSON.stringify(j);
  assert.ok(!raw.includes("apiKey") && !raw.includes("baseUrl") && !raw.includes("sk-"), "响应中不得出现密钥/地址");
  assert.ok(!raw.includes("accessPasswordHash"), "响应中不得出现密码哈希");
});

await test("使用密码：错误密码被拒绝（并计数限流）", async () => {
  const st = createMemoryStorage();
  for (let i = 0; i < 10; i++) {
    const r = await call("/api/verify", { method: "POST", body: { password: "wrong" }, storage: st });
    assert.equal(r.j.code, "E_PASSWORD");
  }
  const r11 = await call("/api/verify", { method: "POST", body: { password: "wrong" }, storage: st });
  assert.equal(r11.status, 429);
  assert.equal(r11.j.code, "E_PASSWORD");
});

await test("使用密码：默认密码可获取令牌", async () => {
  const { j } = await call("/api/verify", { method: "POST", body: { password: "yihua2026" } });
  assert.equal(j.ok, true);
  assert.ok(j.token.length > 20);
  assert.equal(j.usage.limit, 10);
});

await test("使用密码：环境变量覆盖默认密码", async () => {
  const env = { YIHUA_MOCK_UPSTREAM: "1", ACCESS_PASSWORD: "env-pass-9" };
  const bad = await call("/api/verify", { method: "POST", body: { password: "yihua2026" }, env });
  assert.notEqual(bad.j.ok, true);
  const good = await call("/api/verify", { method: "POST", body: { password: "env-pass-9" }, env });
  assert.equal(good.j.ok, true);
});

console.log("\n== 生成流程（模拟上游） ==");

async function getValidToken(env = MOCK_ENV, ip = "203.0.113.10", storage = null) {
  const { j } = await call("/api/verify", { method: "POST", body: { password: "yihua2026" }, env, ip, storage });
  return j.token;
}

await test("生成：无令牌 / 篡改令牌被拒绝", async () => {
  const noTok = await call("/api/generate", { method: "POST", body: { prompt: "test", model: "gpt-image-2", channelId: "ch1", ratio: "1:1" } });
  assert.equal(noTok.j.code, "E_PASSWORD");
  const badTok = await call("/api/generate", { method: "POST", body: { prompt: "test", model: "gpt-image-2", channelId: "ch1", ratio: "1:1", token: "abc.def" } });
  assert.equal(badTok.j.code, "E_PASSWORD");
});

await test("生成：空提示词 / 超长提示词 / 未开放模型", async () => {
  const token = await getValidToken();
  const empty = await call("/api/generate", { method: "POST", body: { prompt: "  ", model: "gpt-image-2", channelId: "ch1", token } });
  assert.equal(empty.j.code, "E_INPUT");
  const long = await call("/api/generate", { method: "POST", body: { prompt: "字".repeat(2001), model: "gpt-image-2", channelId: "ch1", token } });
  assert.equal(long.j.code, "E_INPUT");
  const badModel = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "dall-e-3", channelId: "ch1", token } });
  assert.equal(badModel.j.code, "E_INPUT");
});

await test("生成：停用/不存在通道被拒绝", async () => {
  const token = await getValidToken();
  const off = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "gpt-image-2", channelId: "ch999", token } });
  assert.equal(off.j.code, "E_CHANNEL_OFF");
});

await test("生成：成功返回图片并计数", async () => {
  const ip = "198.51.100.7";
  const st = createMemoryStorage();
  const token = await getValidToken(MOCK_ENV, ip, st);
  const r = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "gpt-image-2", channelId: "ch1", ratio: "21:9", token }, storage: st, ip });
  assert.equal(r.j.ok, true, r.j.message || "");
  assert.equal(r.j.size, "1792x768");
  assert.ok(r.j.image.b64.startsWith("iVBOR"), "应返回 PNG base64");
  assert.equal(r.j.usage.used, 1);
  assert.equal(r.j.usage.remaining, 9);
  const cfg2 = await call("/api/config", { storage: st, ip });
  assert.equal(cfg2.j.usage.used, 1);
});

await test("每日限额：第 11 次被拦截且不计额", async () => {
  const ip = "198.51.100.8";
  const st = createMemoryStorage();
  const token = await getValidToken(MOCK_ENV, ip, st);
  for (let i = 0; i < 10; i++) {
    const r = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "gpt-image-2", channelId: "ch1", token }, storage: st, ip });
    assert.equal(r.j.ok, true, "第 " + (i + 1) + " 次应成功");
  }
  const r11 = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "gpt-image-2", channelId: "ch1", token }, storage: st, ip });
  assert.equal(r11.status, 429);
  assert.equal(r11.j.code, "E_QUOTA_IP");
  assert.equal(r11.j.remaining, 0);
  const other = await call("/api/config", { storage: st, ip: "198.51.100.9" });
  assert.equal(other.j.usage.used, 0);
});

await test("模拟上游故障：500/429/401 映射为清晰中文报错", async () => {
  const token = await getValidToken();
  const e500 = await call("/api/generate", { method: "POST", body: { prompt: "模拟失败测试", model: "gpt-image-2", channelId: "ch1", token } });
  assert.equal(e500.j.code, "E_UPSTREAM");
  assert.equal(e500.j.upstreamStatus, 500);
  assert.ok(e500.j.message.includes("暂时不可用"));
  const e429 = await call("/api/generate", { method: "POST", body: { prompt: "模拟限流测试", model: "gpt-image-2", channelId: "ch1", token } });
  assert.equal(e429.j.code, "E_UPSTREAM");
  assert.equal(e429.j.upstreamStatus, 429);
  assert.ok(e429.j.message.includes("额度不足"));
  const e401 = await call("/api/generate", { method: "POST", body: { prompt: "模拟密钥测试", model: "gpt-image-2", channelId: "ch1", token } });
  assert.equal(e401.j.code, "E_UPSTREAM");
  assert.equal(e401.j.upstreamStatus, 401);
  assert.ok(e401.j.message.includes("密钥无效"));
});

console.log("\n== 图生图 ==");

function pngBlob() {
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

await test("图生图：multipart 成功", async () => {
  const ip = "198.51.100.20";
  const st = createMemoryStorage();
  const token = await getValidToken(MOCK_ENV, ip, st);
  const fd = new FormData();
  fd.append("token", token);
  fd.append("channelId", "ch1");
  fd.append("model", "gpt-image-2");
  fd.append("ratio", "16:9");
  fd.append("prompt", "把背景换成黄昏");
  fd.append("image", pngBlob(), "ref.png");
  const r = await call("/api/edit", { method: "POST", body: fd, ip, storage: st });
  assert.equal(r.j.ok, true, r.j.message || "");
  assert.equal(r.j.size, "1536x864");
  assert.equal(r.j.usage.used, 1);
});

await test("图生图：格式校验（拒绝 GIF / 缺图）", async () => {
  const ip = "198.51.100.21";
  const st = createMemoryStorage();
  const token = await getValidToken(MOCK_ENV, ip, st);
  const fd = new FormData();
  fd.append("token", token);
  fd.append("channelId", "ch1");
  fd.append("model", "gpt-image-2");
  fd.append("prompt", "改");
  fd.append("image", new Blob([new Uint8Array(4)], { type: "image/gif" }), "a.gif");
  const r = await call("/api/edit", { method: "POST", body: fd, ip, storage: st });
  assert.equal(r.j.code, "E_IMAGE");
  const fd2 = new FormData();
  fd2.append("token", token);
  fd2.append("channelId", "ch1");
  fd2.append("model", "gpt-image-2");
  fd2.append("prompt", "改");
  const r2 = await call("/api/edit", { method: "POST", body: fd2, ip, storage: st });
  assert.equal(r2.j.code, "E_IMAGE");
});

console.log("\n== 管理后台 ==");

async function adminToken(storage = null) {
  const { j } = await call("/api/admin/login", { method: "POST", body: { password: "yihua-admin-2026" }, storage });
  return j.token;
}

await test("管理登录：错误被拒，正确发令牌", async () => {
  const bad = await call("/api/admin/login", { method: "POST", body: { password: "nope" } });
  assert.equal(bad.j.code, "E_ADMIN");
  const good = await call("/api/admin/login", { method: "POST", body: { password: "yihua-admin-2026" } });
  assert.equal(good.j.ok, true);
});

await test("管理配置：读取含密钥（仅管理员），保存并生效", async () => {
  const st = createMemoryStorage();
  const token = await adminToken(st);
  const get1 = await call("/api/admin/config", { headers: { "x-admin-token": token }, storage: st });
  assert.equal(get1.j.ok, true);
  assert.equal(get1.j.config.channels[0].apiKey.startsWith("sk-"), true);
  assert.equal(get1.j.meta.storage, "memory");
  const save = await call("/api/admin/config", {
    method: "POST",
    headers: { "x-admin-token": token },
    storage: st,
    body: {
      config: {
        channels: [
          { id: "ch1", name: "主力", baseUrl: "https://api.example.com", apiKey: "sk-xxx-1", enabled: true, dailyLimit: 2, models: ["m-a", "m-b", "bad model name!", "m-a"] },
          { name: "备用", baseUrl: "https://api2.example.com", apiKey: "sk-xxx-2", enabled: false, dailyLimit: 0, models: ["m-c"] },
        ],
        settings: { perIpDailyLimit: 5, announcement: "公告测试", accessPassword: "", adminPassword: "" },
      },
    },
  });
  assert.equal(save.j.ok, true, save.j.message || "");
  assert.equal(save.j.config.channels[0].models.length, 2, "非法模型被过滤且去重");
  assert.equal(save.j.config.channels[1].id, "ch2", "新通道自动分配 id");
  const pub = await call("/api/config", { storage: st, ip: "198.51.100.30" });
  assert.equal(pub.j.channels.length, 2);
  assert.equal(pub.j.channels[1].enabled, false);
  assert.equal(pub.j.usage.limit, 5);
  assert.equal(pub.j.settings.announcement, "公告测试");
});

await test("每通道限额：通道额度满后报 E_QUOTA_CHANNEL，config 标记 full", async () => {
  const st = createMemoryStorage();
  const at = await adminToken(st);
  await call("/api/admin/config", {
    method: "POST",
    headers: { "x-admin-token": at },
    storage: st,
    body: {
      config: {
        channels: [
          { id: "ch1", name: "甲", baseUrl: "https://api.example.com", apiKey: "sk-1", enabled: true, dailyLimit: 2, models: ["m-a"] },
          { id: "ch2", name: "乙", baseUrl: "https://api2.example.com", apiKey: "sk-2", enabled: true, dailyLimit: 0, models: ["m-b"] },
        ],
        settings: { perIpDailyLimit: 10 },
      },
    },
  });
  const ip = "198.51.100.40";
  const vt = (await call("/api/verify", { method: "POST", body: { password: "yihua2026" }, storage: st, ip })).j.token;
  for (let i = 0; i < 2; i++) {
    const r = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "m-a", channelId: "ch1", token: vt }, storage: st, ip });
    assert.equal(r.j.ok, true, r.j.message || "");
  }
  const r3 = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "m-a", channelId: "ch1", token: vt }, storage: st, ip });
  assert.equal(r3.j.code, "E_QUOTA_CHANNEL");
  assert.ok(r3.j.message.includes("甲"));
  const pub = await call("/api/config", { storage: st, ip });
  assert.equal(pub.j.channels[0].full, true);
  assert.equal(pub.j.channels[1].full, false);
  const okB = await call("/api/generate", { method: "POST", body: { prompt: "测试", model: "m-b", channelId: "ch2", token: vt }, storage: st, ip });
  assert.equal(okB.j.ok, true);
});

await test("管理配置：非法输入被拒绝", async () => {
  const st = createMemoryStorage();
  const at = await adminToken(st);
  const h = { "x-admin-token": at };
  const noAuth = await call("/api/admin/config", { method: "POST", storage: st, body: { config: { channels: [], settings: {} } } });
  assert.equal(noAuth.j.code, "E_ADMIN");
  const noCh = await call("/api/admin/config", { method: "POST", headers: h, storage: st, body: { config: { channels: [], settings: {} } } });
  assert.equal(noCh.j.code, "E_CONFIG");
  const badUrl = await call("/api/admin/config", {
    method: "POST", headers: h, storage: st,
    body: { config: { channels: [{ name: "x", baseUrl: "notaurl", apiKey: "k", models: ["m"] }], settings: {} } },
  });
  assert.equal(badUrl.j.code, "E_CONFIG");
  const noModel = await call("/api/admin/config", {
    method: "POST", headers: h, storage: st,
    body: { config: { channels: [{ name: "x", baseUrl: "https://a.com", apiKey: "k", models: [] }], settings: {} } },
  });
  assert.equal(noModel.j.code, "E_CONFIG");
  const weakPw = await call("/api/admin/config", {
    method: "POST", headers: h, storage: st,
    body: { config: { channels: [{ name: "x", baseUrl: "https://a.com", apiKey: "k", models: ["m"] }], settings: { accessPassword: "abc" } } },
  });
  assert.equal(weakPw.j.code, "E_CONFIG");
});

await test("管理修改访客密码后：旧密码失效、新密码可用、旧令牌失效", async () => {
  const st = createMemoryStorage();
  const oldTok = await getValidToken(MOCK_ENV, "198.51.100.50", st);
  const at = await adminToken(st);
  await call("/api/admin/config", {
    method: "POST", headers: { "x-admin-token": at }, storage: st,
    body: { config: {
      channels: [{ id: "ch1", name: "甲", baseUrl: "https://api.example.com", apiKey: "sk-1", enabled: true, dailyLimit: 0, models: ["m-a"] }],
      settings: { perIpDailyLimit: 10, accessPassword: "new-pass-88" },
    } },
  });
  const oldPw = await call("/api/verify", { method: "POST", body: { password: "yihua2026" }, storage: st, ip: "198.51.100.50" });
  assert.notEqual(oldPw.j.ok, true);
  const newPw = await call("/api/verify", { method: "POST", body: { password: "new-pass-88" }, storage: st, ip: "198.51.100.50" });
  assert.equal(newPw.j.ok, true);
  const useOld = await call("/api/generate", { method: "POST", body: { prompt: "x", model: "m-a", channelId: "ch1", token: oldTok }, storage: st, ip: "198.51.100.50" });
  assert.equal(useOld.j.code, "E_PASSWORD");
  const useNew = await call("/api/generate", { method: "POST", body: { prompt: "x", model: "m-a", channelId: "ch1", token: newPw.j.token }, storage: st, ip: "198.51.100.50" });
  assert.equal(useNew.j.ok, true);
});

await test("连通性测试接口", async () => {
  const st = createMemoryStorage();
  const at = await adminToken(st);
  await call("/api/admin/config", {
    method: "POST", headers: { "x-admin-token": at }, storage: st,
    body: { config: {
      channels: [{ id: "ch1", name: "甲", baseUrl: "https://mock.local", apiKey: "sk-1", enabled: true, dailyLimit: 0, models: ["m-a"] }],
      settings: {},
    } },
  });
  const r = await call("/api/admin/test-channel", { method: "POST", headers: { "x-admin-token": at }, storage: st, body: { channelId: "ch1" } });
  assert.equal(r.j.ok, true);
  assert.equal(r.j.reachable, true);
});

await test("路由 404 与错误 JSON 结构", async () => {
  const r = await call("/api/nothing");
  assert.equal(r.status, 404);
  assert.equal(r.j.ok, false);
  assert.ok(r.j.message);
});

console.log("\n========================");
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  failures.forEach((f) => {
    console.log("\n失败: " + f.name);
    console.log(f.e && f.e.stack || f.e);
  });
  process.exit(1);
}
console.log("全部通过");
