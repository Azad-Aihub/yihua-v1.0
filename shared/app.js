// 一画 · 共享应用（所有部署平台共用同一套业务逻辑）
// 路由：
//   GET  /api/health            健康检查（含存储方式）
//   GET  /api/config            公开配置（不含任何密钥）
//   POST /api/verify            使用密码验证 → 颁发访问令牌
//   POST /api/generate          文生图（/v1/images/generations）
//   POST /api/edit              图生图（/v1/images/edits，multipart）
//   POST /api/admin/login       管理登录
//   GET  /api/admin/config      管理读取配置（含密钥，需管理员令牌）
//   POST /api/admin/config      管理保存配置
//   POST /api/admin/test-channel 管理测试通道连通性

import {
  APP_VERSION, BRAND, RATIOS, DEFAULT_SETTINGS, DEFAULT_CHANNELS,
  CONFIG_KEY, MAX_PROMPT_LEN, MAX_UPLOAD_BYTES, MAX_CHANNELS,
  TOKEN_TTL_DAYS, ADMIN_TTL_DAYS, UPSTREAM_TIMEOUT_MS, PW_FAIL_LIMIT,
} from "./config.js";
import {
  json, errJson, str, toInt, clampInt, truncate,
  cstDate, cstHour, getClientIP,
  computeSize, nearestStdSize,
  sha256hex, passwordMatches, signToken, verifyToken, readJson,
} from "./util.js";
import { createMemoryStorage, resolveStorage } from "./storage.js";
import { mockFetch } from "./mock.js";

/* ---------------- 配置缓存（按存储实例隔离，30 秒） ---------------- */

const cfgCache = new WeakMap(); // storage -> { at, data }

function ensureShape(data) {
  const s = data.settings = data.settings && typeof data.settings === "object" ? data.settings : {};
  if (!Number.isFinite(toInt(s.perIpDailyLimit, 0)) || toInt(s.perIpDailyLimit, 0) <= 0) s.perIpDailyLimit = DEFAULT_SETTINGS.perIpDailyLimit;
  if (typeof s.announcement !== "string") s.announcement = "";
  if (typeof s.accessPasswordHash !== "string") s.accessPasswordHash = null;
  if (typeof s.adminPasswordHash !== "string") s.adminPasswordHash = null;
  const chs = Array.isArray(data.channels) ? data.channels : [];
  data.channels = chs.filter((c) => c && typeof c === "object");
  return data;
}

async function seedConfig(store) {
  const data = {
    v: 1,
    channels: JSON.parse(JSON.stringify(DEFAULT_CHANNELS)),
    settings: {
      perIpDailyLimit: DEFAULT_SETTINGS.perIpDailyLimit,
      announcement: DEFAULT_SETTINGS.announcement,
      accessPasswordHash: await sha256hex("yihua-salt-v1|" + DEFAULT_SETTINGS.accessPassword),
      adminPasswordHash: await sha256hex("yihua-salt-v1|" + DEFAULT_SETTINGS.adminPassword),
    },
  };
  try {
    if (store.type !== "memory") await store.put(CONFIG_KEY, JSON.stringify(data), 0);
  } catch {}
  return data;
}

async function loadConfig(store, fresh = false) {
  const cached = cfgCache.get(store);
  if (!fresh && cached && Date.now() - cached.at < 30000) return cached.data;
  let data = null;
  const raw = await store.get(CONFIG_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.channels) && parsed.channels.length) data = parsed;
    } catch {}
  }
  if (!data) data = await seedConfig(store);
  ensureShape(data);
  cfgCache.set(store, { at: Date.now(), data });
  return data;
}

async function saveConfig(store, data) {
  await store.put(CONFIG_KEY, JSON.stringify(data), 0);
  cfgCache.set(store, { at: Date.now(), data });
}

/* ---------------- 运行环境辅助 ---------------- */

function effectiveValues(env, cfg) {
  return {
    accessPassword: str(env.ACCESS_PASSWORD) || null, // 环境变量优先
    adminPassword: str(env.ADMIN_PASSWORD) || null,
    storedAccessHash: cfg.settings.accessPasswordHash,
    storedAdminHash: cfg.settings.adminPasswordHash,
  };
}

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

async function usageOf(store, ip) {
  const date = cstDate();
  const used = toInt(await store.get(`rl:${date}:${ip}`));
  return { date, used };
}

/** 令牌签名密钥：由服务端实际生效的密码哈希派生（改密码即全体令牌失效） */
async function accessSecret(env, cfg) {
  const ev = effectiveValues(env, cfg);
  if (ev.accessPassword) return sha256hex("yihua-salt-v1|" + ev.accessPassword + "|tok");
  if (ev.storedAccessHash) return sha256hex(ev.storedAccessHash + "|tok");
  return sha256hex("yihua-salt-v1|" + DEFAULT_SETTINGS.accessPassword + "|tok");
}

async function adminSecret(env, cfg) {
  const ev = effectiveValues(env, cfg);
  if (ev.adminPassword) return sha256hex("yihua-salt-v1|" + ev.adminPassword + "|adm");
  if (ev.storedAdminHash) return sha256hex(ev.storedAdminHash + "|adm");
  return sha256hex("yihua-salt-v1|" + DEFAULT_SETTINGS.adminPassword + "|adm");
}

/* ---------------- 主入口 ---------------- */

export async function handleRequest(request, env = {}, storageArg = null, opts = {}) {
  const store = storageArg || resolveStorage(env) || createMemoryStorage();
  const isMock = str(env.YIHUA_MOCK_UPSTREAM) === "1";
  const doFetch = isMock ? mockFetch : (opts.fetchImpl || fetch);

  const u = new URL(request.url);
  let path = u.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const m = (request.method || "GET").toUpperCase();

  // ---- 管理配置对象（懒加载） ----
  let cfgPromise = null;
  const cfg = (fresh = false) => {
    if (!cfgPromise || fresh) cfgPromise = loadConfig(store, fresh);
    return cfgPromise;
  };

  /* ----- 公开接口 ----- */

  if (path === "/api/health" && m === "GET") {
    return json({
      ok: true, app: BRAND.name, version: APP_VERSION,
      storage: store.type, mock: isMock, time: new Date().toISOString(),
    });
  }

  if (path === "/api/config" && m === "GET") {
    const c = await cfg();
    const ip = getClientIP(request);
    const limit = clampInt(c.settings.perIpDailyLimit, 1, 100);
    const { used } = await usageOf(store, ip);
    const date = cstDate();
    const channels = [];
    for (const ch of c.channels) {
      const chLimit = toInt(ch.dailyLimit, 0);
      let chUsed = 0;
      if (chLimit > 0) chUsed = toInt(await store.get(`chq:${date}:${ch.id}`));
      channels.push({
        id: ch.id,
        name: str(ch.name) || ch.id,
        enabled: !!ch.enabled,
        models: Array.isArray(ch.models) ? ch.models.slice(0, 30) : [],
        quota: chLimit > 0 ? { used: chUsed, limit: chLimit } : null,
        full: chLimit > 0 && chUsed >= chLimit,
      });
    }
    return json({
      ok: true,
      brand: BRAND,
      ratios: RATIOS,
      channels,
      settings: { perIpDailyLimit: limit, announcement: str(c.settings.announcement) },
      usage: { used, limit, remaining: Math.max(0, limit - used) },
      accessRequired: true,
      mock: isMock,
      version: APP_VERSION,
      serverTime: new Date().toISOString(),
    });
  }

  if (path === "/api/verify" && m === "POST") {
    const body = await readJson(request);
    const c = await cfg();
    const ip = getClientIP(request);
    const failKey = `pwf:${cstHour()}:${ip}`;
    const fails = toInt(await store.get(failKey));
    if (fails >= PW_FAIL_LIMIT) {
      return errJson("E_PASSWORD", "密码尝试次数过多，请 1 小时后再试", 429);
    }
    const ev = effectiveValues(env, c);
    let pass = false;
    if (ev.accessPassword) {
      pass = await passwordMatches(str(body.password), ev.accessPassword);
    } else if (ev.storedAccessHash) {
      pass = (await sha256hex("yihua-salt-v1|" + str(body.password))) === ev.storedAccessHash;
    } else {
      pass = await passwordMatches(str(body.password), DEFAULT_SETTINGS.accessPassword);
    }
    if (!pass) {
      await store.put(failKey, String(fails + 1), 3600);
      return errJson("E_PASSWORD", "使用密码不正确，请向站点管理员获取", 401);
    }
    const token = await signToken({ t: "v", exp: Date.now() + TOKEN_TTL_DAYS * 86400000 }, await accessSecret(env, c));
    const limit = clampInt(c.settings.perIpDailyLimit, 1, 100);
    const { used } = await usageOf(store, ip);
    return json({
      ok: true, token,
      expiresInDays: TOKEN_TTL_DAYS,
      usage: { used, limit, remaining: Math.max(0, limit - used) },
    });
  }

  /* ----- 生成（文生图 / 图生图共用主流程） ----- */

  async function precheckGenerate(body, tokenIn) {
    const c = await cfg();
    // 1. 访客令牌
    const token = str(tokenIn).trim();
    const payload = token ? await verifyToken(token, await accessSecret(env, c), "v") : null;
    if (!payload) return { err: errJson("E_PASSWORD", "登录状态已失效，请重新输入使用密码", 401) };
    // 2. 通道
    const channel = c.channels.find((x) => x.id === str(body.channelId) && x.enabled);
    if (!channel) return { err: errJson("E_CHANNEL_OFF", "所选通道不可用（已停用或不存在），请切换其他通道", 400) };
    const model = str(body.model);
    if (!Array.isArray(channel.models) || !channel.models.includes(model)) {
      return { err: errJson("E_INPUT", "当前通道未开放该模型，请重新选择", 400) };
    }
    // 3. 每日限额（按成功生成计数）
    const ip = getClientIP(request);
    const limit = clampInt(c.settings.perIpDailyLimit, 1, 100);
    const date = cstDate();
    const usedBefore = toInt(await store.get(`rl:${date}:${ip}`));
    if (usedBefore >= limit) {
      return { err: errJson("E_QUOTA_IP", `今日生成额度已用完（每位访客每日 ${limit} 张），明天再来吧`, 429, { remaining: 0, limit }) };
    }
    const chLimit = toInt(channel.dailyLimit, 0);
    if (chLimit > 0) {
      const chUsed = toInt(await store.get(`chq:${date}:${channel.id}`));
      if (chUsed >= chLimit) {
        return { err: errJson("E_QUOTA_CHANNEL", `「${str(channel.name) || channel.id}」今日额度已满（${chLimit} 张），请切换其他通道`, 429) };
      }
    }
    return { c, channel, model, ip, date, limit, chLimit };
  }

  function upstreamError(res, channelName) {
    return res.text().then((text) => {
      const status = res.status;
      const snippet = truncate(str(text).replace(/\s+/g, " ").trim(), 220);
      let msg;
      if (status === 401 || status === 403) msg = `「${channelName}」的接口密钥无效或没有权限（HTTP ${status}），请联系管理员检查通道配置`;
      else if (status === 404) msg = `「${channelName}」的接口地址不正确（HTTP 404），请联系管理员检查通道配置`;
      else if (status === 429) msg = `「${channelName}」上游额度不足或请求过于频繁（HTTP 429），请稍后重试或切换其他通道`;
      else if (status >= 500) msg = `「${channelName}」上游服务暂时不可用（HTTP ${status}），请稍后重试或切换其他通道`;
      else msg = `生成失败（HTTP ${status}），请稍后重试或切换其他通道`;
      return errJson("E_UPSTREAM", msg, 502, { upstreamStatus: status, upstreamError: snippet });
    });
  }

  async function finishGeneration(res, ctx, meta) {
    const { channel, ip, date, limit, chLimit } = ctx;
    const channelName = str(channel.name) || channel.id;
    if (!res.ok) return await upstreamError(res, channelName);
    let j;
    try {
      j = await res.json();
    } catch {
      return errJson("E_UPSTREAM", `「${channelName}」返回了无法解析的数据，请稍后重试`, 502);
    }
    const item = j && Array.isArray(j.data) ? j.data[0] : null;
    if (!item) {
      return errJson("E_UPSTREAM", `「${channelName}」未返回图片数据，请稍后重试或切换通道`, 502);
    }
    let image = null;
    if (item.b64_json) {
      image = { kind: "b64", b64: String(item.b64_json), mime: str(item.mime_type) || "image/png" };
    } else if (item.url) {
      image = { kind: "url", url: String(item.url), mime: str(item.mime_type) || "image/png" };
    } else {
      return errJson("E_UPSTREAM", `「${channelName}」未返回图片数据，请稍后重试或切换通道`, 502);
    }
    // 仅成功时计数
    const used = await store.incr(`rl:${date}:${ip}`, 172800);
    let chUsed = null;
    if (chLimit > 0) chUsed = await store.incr(`chq:${date}:${channel.id}`, 172800);
    const notices = [];
    if (meta.retried) notices.push("该模型暂不支持所选画幅，已自动改用最接近的标准画幅");
    if (isMock) notices.push("本地演示模式：图片为模拟占位图");
    return json({
      ok: true,
      image,
      model: ctx.model,
      size: meta.usedSize,
      ratio: meta.ratio,
      width: toInt(item.width, 0) || null,
      height: toInt(item.height, 0) || null,
      revisedPrompt: truncate(str(item.revised_prompt), 200) || null,
      channel: { id: channel.id, name: channelName },
      usage: { used, limit, remaining: Math.max(0, limit - used) },
      elapsedMs: meta.elapsed,
      notice: notices.join("；") || null,
    });
  }

  async function callUpstream(channel, url, bodyInit) {
    const headers = { authorization: `Bearer ${str(channel.apiKey)}` };
    return doFetch(url, { ...bodyInit, headers, signal: timeoutSignal(UPSTREAM_TIMEOUT_MS) });
  }

  if (path === "/api/generate" && m === "POST") {
    const body = await readJson(request);
    const pre = await precheckGenerate(body, str(body.token) || request.headers.get("x-access-token"));
    if (pre.err) return pre.err;
    const { channel, model } = pre;

    const prompt = str(body.prompt).trim();
    if (!prompt) return errJson("E_INPUT", "请先描述你想画的画面", 400);
    if (prompt.length > MAX_PROMPT_LEN) {
      return errJson("E_INPUT", `画面描述太长了（最多 ${MAX_PROMPT_LEN} 字），请精简后再试`, 400);
    }

    const ratio = str(body.ratio) || "1:1";
    let size = computeSize(ratio);
    if (!size) size = "1024x1024";

    const base = str(channel.baseUrl).replace(/\/+$/, "");
    const url = base + "/v1/images/generations";
    const t0 = Date.now();
    const payload = JSON.stringify({ model, prompt, n: 1, size });

    let res;
    try {
      res = await callUpstream(channel, url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    } catch (e) {
      return errJson("E_CHANNEL_FAIL", `无法连接「${str(channel.name) || channel.id}」的服务器（网络错误或地址不可达），请稍后重试或切换其他通道`, 502);
    }

    let retried = false;
    let usedSize = size;
    if (!res.ok && res.status === 400) {
      const retrySize = size === "auto" ? "1024x1024" : nearestStdSize(ratio);
      if (retrySize !== size) {
        try {
          res = await callUpstream(channel, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt, n: 1, size: retrySize }) });
          usedSize = retrySize;
          retried = true;
        } catch (e) {
          return errJson("E_CHANNEL_FAIL", `无法连接「${str(channel.name) || channel.id}」的服务器，请稍后重试或切换其他通道`, 502);
        }
      }
    }

    return await finishGeneration(res, { ...pre, model }, {
      retried, usedSize, ratio, elapsed: Date.now() - t0,
    });
  }

  if (path === "/api/edit" && m === "POST") {
    let form;
    try {
      form = await request.formData();
    } catch {
      return errJson("E_INPUT", "请求格式错误（应为表单上传）", 400);
    }
    const body = {
      token: str(form.get("token")) || str(request.headers.get("x-access-token")),
      channelId: str(form.get("channelId")),
      model: str(form.get("model")),
      ratio: str(form.get("ratio")) || "1:1",
    };
    const pre = await precheckGenerate(body, body.token);
    if (pre.err) return pre.err;
    const { channel, model } = pre;

    const prompt = str(form.get("prompt")).trim();
    if (!prompt) return errJson("E_INPUT", "请描述你希望如何修改这张图", 400);
    if (prompt.length > MAX_PROMPT_LEN) {
      return errJson("E_INPUT", `修改描述太长了（最多 ${MAX_PROMPT_LEN} 字），请精简后再试`, 400);
    }

    const file = form.get("image");
    if (!file || typeof file === "string") {
      return errJson("E_IMAGE", "请上传一张参考图片", 400);
    }
    const type = str(file.type).toLowerCase();
    if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(type)) {
      return errJson("E_IMAGE", "仅支持 PNG / JPG / WebP 格式的图片", 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return errJson("E_IMAGE", "图片太大了，请上传 8 MB 以内的图片", 400);
    }

    const ratio = body.ratio;
    let size = computeSize(ratio);
    if (!size) size = "1024x1024";

    const base = str(channel.baseUrl).replace(/\/+$/, "");
    const url = base + "/v1/images/edits";
    const t0 = Date.now();

    const makeForm = (sz) => {
      const fd = new FormData();
      fd.append("model", model);
      fd.append("prompt", prompt);
      fd.append("n", "1");
      fd.append("size", sz);
      fd.append("image", file, str(file.name) || "reference.png");
      return fd;
    };

    let res;
    try {
      res = await callUpstream(channel, url, { method: "POST", body: makeForm(size) });
    } catch (e) {
      return errJson("E_CHANNEL_FAIL", `无法连接「${str(channel.name) || channel.id}」的服务器（网络错误或地址不可达），请稍后重试或切换其他通道`, 502);
    }

    let retried = false;
    let usedSize = size;
    if (!res.ok && res.status === 400) {
      const retrySize = size === "auto" ? "1024x1024" : nearestStdSize(ratio);
      if (retrySize !== size) {
        try {
          res = await callUpstream(channel, url, { method: "POST", body: makeForm(retrySize) });
          usedSize = retrySize;
          retried = true;
        } catch (e) {
          return errJson("E_CHANNEL_FAIL", `无法连接「${str(channel.name) || channel.id}」的服务器，请稍后重试或切换其他通道`, 502);
        }
      }
    }

    return await finishGeneration(res, { ...pre, model }, {
      retried, usedSize, ratio, elapsed: Date.now() - t0,
    });
  }

  /* ----- 管理后台 ----- */

  if (path === "/api/admin/login" && m === "POST") {
    const body = await readJson(request);
    const c = await cfg(true);
    const ip = getClientIP(request);
    const failKey = `awf:${cstHour()}:${ip}`;
    const fails = toInt(await store.get(failKey));
    if (fails >= PW_FAIL_LIMIT) {
      return errJson("E_ADMIN", "尝试次数过多，请 1 小时后再试", 429);
    }
    const ev = effectiveValues(env, c);
    let pass = false;
    if (ev.adminPassword) {
      pass = await passwordMatches(str(body.password), ev.adminPassword);
    } else if (ev.storedAdminHash) {
      pass = (await sha256hex("yihua-salt-v1|" + str(body.password))) === ev.storedAdminHash;
    } else {
      pass = await passwordMatches(str(body.password), DEFAULT_SETTINGS.adminPassword);
    }
    if (!pass) {
      await store.put(failKey, String(fails + 1), 3600);
      return errJson("E_ADMIN", "管理密码不正确", 401);
    }
    const token = await signToken({ t: "a", exp: Date.now() + ADMIN_TTL_DAYS * 86400000 }, await adminSecret(env, c));
    return json({ ok: true, token, expiresInDays: ADMIN_TTL_DAYS });
  }

  async function requireAdmin(request, cfgObj) {
    const token = str(request.headers.get("x-admin-token")).trim();
    const payload = token ? await verifyToken(token, await adminSecret(env, cfgObj), "a") : null;
    if (!payload) return false;
    return true;
  }

  function adminView(c) {
    return {
      channels: c.channels.map((ch) => ({
        id: ch.id,
        name: str(ch.name),
        baseUrl: str(ch.baseUrl),
        apiKey: str(ch.apiKey),
        enabled: !!ch.enabled,
        dailyLimit: toInt(ch.dailyLimit, 0),
        models: Array.isArray(ch.models) ? ch.models : [],
      })),
      settings: {
        perIpDailyLimit: clampInt(c.settings.perIpDailyLimit, 1, 100),
        announcement: str(c.settings.announcement),
      },
    };
  }

  if (path === "/api/admin/config" && m === "GET") {
    const c = await cfg(u.searchParams.get("fresh") === "1");
    if (!(await requireAdmin(request, c))) {
      return errJson("E_ADMIN", "管理登录已失效，请重新登录", 401);
    }
    return json({
      ok: true,
      config: adminView(c),
      meta: {
        storage: store.type,
        accessFromEnv: !!effectiveValues(env, c).accessPassword,
        adminFromEnv: !!effectiveValues(env, c).adminPassword,
        mock: isMock,
        version: APP_VERSION,
      },
    });
  }

  if (path === "/api/admin/config" && m === "POST") {
    const body = await readJson(request);
    const current = await cfg(true);
    if (!(await requireAdmin(request, current))) {
      return errJson("E_ADMIN", "管理登录已失效，请重新登录", 401);
    }
    // ---- 校验并规范化 ----
    const incoming = body && typeof body.config === "object" ? body.config : null;
    if (!incoming) return errJson("E_CONFIG", "配置格式不正确", 400);

    const inCh = Array.isArray(incoming.channels) ? incoming.channels : [];
    if (inCh.length < 1) return errJson("E_CONFIG", "至少保留一个通道", 400);
    if (inCh.length > MAX_CHANNELS) return errJson("E_CONFIG", `通道数量最多 ${MAX_CHANNELS} 个`, 400);

    const usedIds = new Set();
    const channels = [];
    for (let i = 0; i < inCh.length; i++) {
      const c0 = inCh[i] || {};
      const name = str(c0.name).trim() || `通道${["一", "二", "三", "四", "五", "六"][i] || i + 1}`;
      if (name.length > 20) return errJson("E_CONFIG", `第 ${i + 1} 个通道名称过长（最多 20 字）`, 400);
      const baseUrl = str(c0.baseUrl).trim().replace(/\/+$/, "");
      if (!/^https?:\/\/.+/.test(baseUrl)) return errJson("E_CONFIG", `通道「${name}」的接口地址不合法（应以 http(s):// 开头）`, 400);
      const apiKey = str(c0.apiKey).trim();
      if (!apiKey || apiKey.length > 200) return errJson("E_CONFIG", `通道「${name}」的接口密钥不能为空`, 400);
      const models = (Array.isArray(c0.models) ? c0.models : [])
        .map((x) => str(x).trim())
        .filter((x) => x && /^[\w.\-]{1,64}$/.test(x));
      if (!models.length) return errJson("E_CONFIG", `通道「${name}」至少要开放一个生图模型`, 400);
      if (models.length > 30) return errJson("E_CONFIG", `通道「${name}」的模型数量过多（最多 30 个）`, 400);
      let id = str(c0.id).trim();
      if (!/^[A-Za-z0-9_\-]{2,24}$/.test(id) || usedIds.has(id)) {
        id = "ch" + (i + 1);
        while (usedIds.has(id)) id = "ch" + id + "x";
      }
      usedIds.add(id);
      channels.push({
        id,
        name,
        baseUrl,
        apiKey,
        enabled: !!c0.enabled,
        dailyLimit: clampInt(c0.dailyLimit, 0, 1000000, 0),
        models: [...new Set(models)],
      });
    }

    const st = incoming.settings && typeof incoming.settings === "object" ? incoming.settings : {};
    const settings = {
      perIpDailyLimit: clampInt(st.perIpDailyLimit, 1, 100, current.settings.perIpDailyLimit),
      announcement: truncate(str(st.announcement).trim(), 200),
      accessPasswordHash: current.settings.accessPasswordHash,
      adminPasswordHash: current.settings.adminPasswordHash,
    };
    // 密码留空 = 保持不变；填写 = 更新哈希（环境变量存在时忽略）
    const ev = effectiveValues(env, current);
    const newAccess = str(st.accessPassword).trim();
    if (newAccess && !ev.accessPassword) {
      if (newAccess.length < 4 || newAccess.length > 64) return errJson("E_CONFIG", "访客使用密码长度需在 4–64 位之间", 400);
      settings.accessPasswordHash = await sha256hex("yihua-salt-v1|" + newAccess);
    }
    const newAdmin = str(st.adminPassword).trim();
    if (newAdmin && !ev.adminPassword) {
      if (newAdmin.length < 6 || newAdmin.length > 64) return errJson("E_CONFIG", "管理密码长度需在 6–64 位之间", 400);
      settings.adminPasswordHash = await sha256hex("yihua-salt-v1|" + newAdmin);
    }

    const next = { v: 1, channels, settings };
    await saveConfig(store, next);
    return json({ ok: true, config: adminView(next) });
  }

  if (path === "/api/admin/test-channel" && m === "POST") {
    const body = await readJson(request);
    const c = await cfg();
    if (!(await requireAdmin(request, c))) {
      return errJson("E_ADMIN", "管理登录已失效，请重新登录", 401);
    }
    const channel = c.channels.find((x) => x.id === str(body.channelId));
    if (!channel) return errJson("E_CONFIG", "通道不存在，请先保存后再测试", 400);
    const base = str(channel.baseUrl).replace(/\/+$/, "");
    const t0 = Date.now();
    try {
      let res;
      try {
        res = await doFetch(base + "/v1/models", {
          headers: { authorization: `Bearer ${str(channel.apiKey)}` },
          signal: timeoutSignal(15000),
        });
      } catch {
        res = await doFetch(base, { signal: timeoutSignal(15000) });
        const ms = Date.now() - t0;
        if (res.status < 500) return json({ ok: true, reachable: true, status: res.status, latencyMs: ms, message: `服务器可达（HTTP ${res.status}，${ms}ms）；未提供模型列表接口，无法验证密钥` });
        return json({ ok: false, reachable: false, status: res.status, latencyMs: ms, message: `服务器异常（HTTP ${res.status}）` });
      }
      const ms = Date.now() - t0;
      if (res.status === 200) return json({ ok: true, reachable: true, status: 200, latencyMs: ms, message: `连接正常，密钥有效（${ms}ms）` });
      if (res.status === 401 || res.status === 403) return json({ ok: false, reachable: true, status: res.status, latencyMs: ms, message: `服务器可达，但密钥无效或无权限（HTTP ${res.status}）` });
      if (res.status < 500) return json({ ok: true, reachable: true, status: res.status, latencyMs: ms, message: `服务器可达（HTTP ${res.status}，${ms}ms）` });
      return json({ ok: false, reachable: true, status: res.status, latencyMs: ms, message: `服务器异常（HTTP ${res.status}）` });
    } catch (e) {
      return json({ ok: false, reachable: false, status: 0, latencyMs: Date.now() - t0, message: "无法连接到该通道的服务器（网络错误或地址不可达）" });
    }
  }

  /* ----- 兜底 ----- */

  if (path.startsWith("/api/")) {
    return errJson("E_ROUTE", "接口不存在（404）", 404);
  }
  return errJson("E_ROUTE", "页面不存在（404）", 404);
}
