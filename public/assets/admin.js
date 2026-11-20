/* 一画 · 管理后台逻辑 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = "yihua_admin";
  var token = "";
  var cfg = null;
  var meta = null;

  function toast(msg, ms) {
    var el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.hidden = true; }, ms || 3600);
  }

  function loadToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  function saveToken(t) {
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "x-admin-token": token }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (r) { return r.json(); });
  }

  /* ---------------- 登录 ---------------- */

  async function login() {
    var pw = $("adminPw").value;
    if (!pw) { showLoginError("请输入管理密码"); return; }
    $("loginBtn").disabled = true;
    try {
      var j = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      }).then(function (r) { return r.json(); });
      if (j.ok) {
        token = j.token;
        saveToken(token);
        enterMain();
      } else {
        showLoginError(j.message || "登录失败");
      }
    } catch (e) {
      showLoginError("网络异常，请稍后重试");
    } finally {
      $("loginBtn").disabled = false;
    }
  }

  function showLoginError(msg) {
    $("loginError").hidden = false;
    $("loginError").textContent = msg;
  }

  $("loginBtn").addEventListener("click", login);
  $("adminPw").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
  $("logoutBtn").addEventListener("click", function () {
    token = "";
    saveToken("");
    location.reload();
  });

  /* ---------------- 主面板 ---------------- */

  async function enterMain() {
    $("loginView").hidden = true;
    $("mainView").hidden = false;
    $("adminHead").hidden = false;
    await loadConfig(true);
  }

  async function loadConfig(fresh) {
    var j = await api("/api/admin/config" + (fresh ? "?fresh=1" : ""));
    if (!j.ok) {
      if (j.code === "E_ADMIN") {
        token = "";
        saveToken("");
        $("loginView").hidden = false;
        $("mainView").hidden = true;
        $("adminHead").hidden = true;
        showLoginError("登录已失效，请重新登录");
        return;
      }
      toast(j.message || "加载配置失败");
      return;
    }
    cfg = j.config;
    meta = j.meta;
    renderMeta();
    renderChannels();
    renderSettings();
  }

  function renderMeta() {
    var badges = $("metaBadges");
    badges.innerHTML = "";
    function badge(cls, dotCls, text) {
      var s = document.createElement("span");
      s.className = "badge " + cls;
      s.innerHTML = '<span class="dot"></span>' + text;
      badges.appendChild(s);
    }
    if (meta.storage === "memory") {
      badge("warn", "", "内存模式（未接入持久化存储）");
    } else {
      badge("ok", "", "存储：" + meta.storage);
    }
    if (meta.mock) badge("warn", "", "演示模式（模拟上游）");
    badge("", "", "版本 v" + meta.version);

    var note = $("metaNote");
    if (meta.storage === "memory") {
      note.textContent = "当前为内存模式：通道配置、限额与密码修改在服务重启后会丢失。Cloudflare 请绑定 KV（变量名 YIHUA_KV）；Vercel 建议配置 Upstash Redis；EdgeOne 请绑定 KV 命名空间（变量名 YIHUA_KV）。详见部署教程。";
    } else {
      note.textContent = "配置与限额将持久保存。修改密码后，所有已登录设备需重新验证。";
    }
    $("accessPwNote").textContent = meta.accessFromEnv ? "已由环境变量 ACCESS_PASSWORD 指定，此处修改无效" : "留空表示不修改";
    $("adminPwNote").textContent = meta.adminFromEnv ? "已由环境变量 ADMIN_PASSWORD 指定，此处修改无效" : "留空表示不修改";
  }

  var chIndex = 0;

  function renderChannels() {
    var list = $("channelList");
    list.innerHTML = "";
    cfg.channels.forEach(function (c, i) {
      list.appendChild(channelCard(c, i));
    });
  }

  function channelCard(c, i) {
    chIndex = Math.max(chIndex, i + 1);
    var div = document.createElement("div");
    div.className = "ch-card";
    div.innerHTML =
      '<div class="ch-head">' +
        '<span class="ch-tag">通道 ' + ["一", "二", "三", "四", "五", "六"][i] + (i > 5 ? i + 1 : "") + '</span>' +
        '<div class="ch-head-right">' +
          '<label class="switch"><input type="checkbox" class="ch-enabled"' + (c.enabled ? " checked" : "") + "> 启用</label>" +
          '<button type="button" class="btn-ghost ch-del" style="color:var(--err);">删除</button>' +
        "</div>" +
      "</div>" +
      '<div class="ch-grid">' +
        '<div><label class="f-label">通道名称</label><input class="inp ch-name" value="' + escAttr(c.name) + '" maxlength="20"></div>' +
        '<div><label class="f-label">每日限额 <span class="optional">0 = 不限</span></label><input class="inp ch-limit" type="number" min="0" value="' + (c.dailyLimit || 0) + '"></div>' +
        '<div class="full"><label class="f-label">接口地址 <span class="optional">API 根地址，如 https://api.example.com</span></label><input class="inp ch-baseurl" value="' + escAttr(c.baseUrl) + '"></div>' +
        '<div class="full"><label class="f-label">接口密钥 <span class="optional">仅保存在服务端，不会暴露给访客</span></label><input class="inp ch-apikey" type="text" value="' + escAttr(c.apiKey) + '" autocomplete="off"></div>' +
        '<div class="full"><label class="f-label">对外开放的生图模型 <span class="optional">每行一个，访客仅能选择这里列出的模型</span></label><textarea class="ta ch-models">' + esc((c.models || []).join("\n")) + '</textarea></div>' +
      "</div>" +
      '<div class="ch-test">' +
        '<button type="button" class="btn-ghost ch-test-btn">测试连通</button>' +
        '<span class="ch-test-result"></span>' +
      "</div>";

    div.querySelector(".ch-del").addEventListener("click", function () {
      if (cfg.channels.length <= 1) { toast("至少保留一个通道"); return; }
      cfg.channels.splice(i, 1);
      renderChannels();
    });
    div.querySelector(".ch-test-btn").addEventListener("click", async function () {
      var resultEl = div.querySelector(".ch-test-result");
      resultEl.className = "ch-test-result";
      resultEl.textContent = "测试中…";
      if (!c.id) {
        resultEl.className = "ch-test-result bad";
        resultEl.textContent = "请先保存配置后再测试";
        return;
      }
      try {
        var j = await api("/api/admin/test-channel", { method: "POST", body: { channelId: c.id } });
        resultEl.className = "ch-test-result " + (j.ok ? "ok" : "bad");
        resultEl.textContent = j.message || (j.ok ? "连接正常" : "连接失败");
      } catch (e) {
        resultEl.className = "ch-test-result bad";
        resultEl.textContent = "网络异常";
      }
    });
    return div;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function escAttr(s) { return esc(s); }

  $("addChannel").addEventListener("click", function () {
    if (cfg.channels.length >= 6) { toast("最多 6 个通道"); return; }
    cfg.channels.push({
      id: "ch" + (++chIndex) + "n",
      name: "通道" + ["一", "二", "三", "四", "五", "六"][cfg.channels.length] || ("通道" + (cfg.channels.length + 1)),
      baseUrl: "",
      apiKey: "",
      enabled: false,
      dailyLimit: 0,
      models: [],
    });
    renderChannels();
  });

  function renderSettings() {
    $("setLimit").value = cfg.settings.perIpDailyLimit;
    $("setAnnounce").value = cfg.settings.announcement || "";
    $("setAccessPw").value = "";
    $("setAdminPw").value = "";
  }

  /* ---------------- 保存 ---------------- */

  $("saveBtn").addEventListener("click", async function () {
    // 从 DOM 收集
    var cards = document.querySelectorAll("#channelList .ch-card");
    var channels = [];
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      var src = cfg.channels[i] || {};
      var models = el.querySelector(".ch-models").value
        .split(/[\n,，、\s]+/)
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
      channels.push({
        id: src.id || "ch" + (i + 1),
        name: el.querySelector(".ch-name").value.trim(),
        baseUrl: el.querySelector(".ch-baseurl").value.trim(),
        apiKey: el.querySelector(".ch-apikey").value.trim(),
        enabled: el.querySelector(".ch-enabled").checked,
        dailyLimit: parseInt(el.querySelector(".ch-limit").value, 10) || 0,
        models: models,
      });
    }
    var body = {
      config: {
        channels: channels,
        settings: {
          perIpDailyLimit: parseInt($("setLimit").value, 10) || 10,
          announcement: $("setAnnounce").value,
          accessPassword: $("setAccessPw").value.trim(),
          adminPassword: $("setAdminPw").value.trim(),
        },
      },
    };
    $("saveBtn").disabled = true;
    try {
      var j = await api("/api/admin/config", { method: "POST", body: body });
      if (j.ok) {
        cfg = j.config;
        toast("已保存，配置立即生效");
        $("saveHint").textContent = "上次保存：" + new Date().toLocaleTimeString();
      } else {
        toast(j.message || "保存失败");
        if (j.code === "E_ADMIN") { token = ""; saveToken(""); setTimeout(function () { location.reload(); }, 1200); }
      }
    } catch (e) {
      toast("网络异常，保存失败");
    } finally {
      $("saveBtn").disabled = false;
    }
  });

  /* ---------------- 启动 ---------------- */

  (async function () {
    token = loadToken();
    if (token) {
      var j = await api("/api/admin/config?fresh=1");
      if (j.ok) {
        cfg = j.config;
        meta = j.meta;
        $("loginView").hidden = true;
        $("mainView").hidden = false;
        $("adminHead").hidden = false;
        renderMeta();
        renderChannels();
        renderSettings();
        return;
      }
      if (j.code === "E_ADMIN") { token = ""; saveToken(""); }
    }
    $("loginView").hidden = false;
  })();
})();
