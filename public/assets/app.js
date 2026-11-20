/* 一画 · 前端逻辑 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var TOKEN_KEY = "yihua_token";

  var state = {
    cfg: null,
    ratio: "1:1",
    channelId: null,
    model: null,
    file: null,
    busy: false,
    history: [],
    current: null,
    lastRun: null,
  };

  var BUSY_WORDS = [
    "正在理解你的描述…",
    "正在构思画面…",
    "正在运笔起稿…",
    "正在晕染上色…",
    "正在细节刻画…",
    "即将完成…",
  ];

  /* ---------------- 工具 ---------------- */

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 3600);
  }

  function fmtSec(ms) { return (ms / 1000).toFixed(1); }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    try {
      var r = await fetch("/api/config", { cache: "no-store" });
      var j = await r.json();
      if (!j.ok) throw new Error(j.message || "配置加载失败");
      state.cfg = j;
      render();
    } catch (e) {
      var box = $("loadError");
      box.hidden = false;
      box.textContent = "无法连接服务：" + (e && e.message || e) + "。请刷新页面重试，若持续出现请联系站点管理员。";
      var btn = $("generateBtn");
      btn.disabled = true;
    }
  }

  function render() {
    var cfg = state.cfg;

    // 公告
    if (cfg.settings.announcement) {
      $("announce").hidden = false;
      $("announce").textContent = cfg.settings.announcement;
    }

    // 比例
    var grid = $("ratioGrid");
    grid.innerHTML = "";
    cfg.ratios.forEach(function (r) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ratio-item" + (r.id === state.ratio ? " active" : "");
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", r.id === state.ratio ? "true" : "false");

      var frame = document.createElement("span");
      frame.className = "ratio-frame";
      var w, h;
      if (r.id === "auto") { w = 34; h = 24; }
      else if (r.w === r.h) { w = 26; h = 26; }
      else if (r.w > r.h) { w = 36; h = Math.max(8, Math.round(36 * r.h / r.w)); }
      else { h = 36; w = Math.max(8, Math.round(36 * r.w / r.h)); }
      frame.style.width = w + "px";
      frame.style.height = h + "px";

      var label = document.createElement("span");
      label.className = "ratio-label";
      label.textContent = r.id === "auto" ? "AI 自动" : r.id;

      btn.appendChild(frame);
      btn.appendChild(label);
      btn.addEventListener("click", function () {
        state.ratio = r.id;
        grid.querySelectorAll(".ratio-item").forEach(function (b) {
          b.classList.remove("active");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-checked", "true");
      });
      grid.appendChild(btn);
    });

    // 通道
    var chSel = $("channelSelect");
    chSel.innerHTML = "";
    var enabled = cfg.channels.filter(function (c) { return c.enabled; });
    if (!enabled.length) {
      var o = document.createElement("option");
      o.value = "";
      o.textContent = "暂无可用通道";
      chSel.appendChild(o);
      chSel.disabled = true;
    }
    enabled.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      var tag = c.name;
      if (c.full) tag += "（今日额度已满）";
      else if (c.quota) tag += "（今日 " + c.quota.used + "/" + c.quota.limit + "）";
      o.textContent = tag;
      chSel.appendChild(o);
    });
    state.channelId = enabled.length ? enabled[0].id : null;
    if (enabled.length) chSel.value = state.channelId;
    chSel.addEventListener("change", function () {
      state.channelId = chSel.value || null;
      renderModels();
      renderChannelHint();
    });

    renderModels();
    renderChannelHint();

    // 模型
    $("modelSelect").addEventListener("change", function () {
      state.model = $("modelSelect").value || null;
    });

    // 额度
    updateUsage(cfg.usage);

    $("quotaNote").textContent = "每位访客每日可成功生成 " + cfg.usage.limit + " 张（按成功出图计）";
    $("footQuota").innerHTML = "每位访客每日可成功生成 <b>" + cfg.usage.limit + "</b> 张 · 今日剩余 <b>" + cfg.usage.remaining + "</b> 张";
    if (cfg.mock) {
      $("footQuota").innerHTML += " · 演示模式";
    }
  }

  function renderModels() {
    var sel = $("modelSelect");
    sel.innerHTML = "";
    var ch = currentChannel();
    if (!ch) {
      var o = document.createElement("option");
      o.value = "";
      o.textContent = "—";
      sel.appendChild(o);
      sel.disabled = true;
      state.model = null;
      return;
    }
    sel.disabled = false;
    ch.models.forEach(function (m, i) {
      var o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
      if (i === 0) state.model = m;
    });
    if (state.model && ch.models.indexOf(state.model) >= 0) {
      sel.value = state.model;
    } else {
      sel.value = ch.models[0];
      state.model = ch.models[0];
    }
    $("modelHint").textContent = ch.models.length + " 个可用模型";
  }

  function renderChannelHint() {
    var ch = currentChannel();
    var el = $("channelHint");
    el.className = "hint";
    if (!ch) { el.textContent = "管理员尚未开放任何通道"; return; }
    if (ch.full) {
      el.className = "hint err";
      el.textContent = "该通道今日额度已满，请切换其他通道";
    } else if (ch.quota) {
      el.textContent = "该通道今日已用 " + ch.quota.used + " / " + ch.quota.limit + " 张";
    } else {
      el.textContent = "该通道不设单独额度，仅受全站每 IP 限额约束";
    }
  }

  function currentChannel() {
    if (!state.cfg || !state.channelId) return null;
    return state.cfg.channels.find(function (c) { return c.id === state.channelId && c.enabled; }) || null;
  }

  function updateUsage(usage) {
    if (!usage) return;
    var chip = $("usageChip");
    chip.hidden = false;
    chip.textContent = "今日 " + usage.used + " / " + usage.limit + " 张";
    chip.className = "usage-chip" + (usage.remaining <= 0 ? " is-full" : "");
    chip.innerHTML = '<span class="dot"></span>今日 ' + usage.used + " / " + usage.limit + " 张";
    if (state.cfg) {
      state.cfg.usage = usage;
      $("footQuota").innerHTML = "每位访客每日可成功生成 <b>" + usage.limit + "</b> 张 · 今日剩余 <b>" + usage.remaining + "</b> 张";
    }
  }

  /* ---------------- 参考图 ---------------- */

  var dz = $("dropzone");
  var fileInput = $("fileInput");

  dz.addEventListener("click", function (e) {
    if (e.target === $("dzRemove") || $("dzRemove").contains(e.target)) return;
    if (!state.file) fileInput.click();
  });
  dz.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && !state.file) { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = "";
  });
  ["dragover", "dragenter"].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("drag"); });
  });
  dz.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  $("dzRemove").addEventListener("click", function (e) {
    e.stopPropagation();
    clearFile();
  });

  function clearFile() {
    state.file = null;
    $("dzPreview").hidden = true;
    $("dzEmpty").hidden = false;
    $("dzImg").removeAttribute("src");
  }

  var ACCEPT = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

  async function handleFile(file) {
    if (ACCEPT.indexOf(file.type) < 0) {
      toast("仅支持 PNG / JPG / WebP 格式的图片");
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      toast("图片太大了，请上传 30 MB 以内的图片");
      return;
    }
    try {
      var processed = await maybeResize(file);
      state.file = processed.blob;
      $("dzImg").src = processed.url;
      $("dzName").textContent = processed.name + (processed.resized ? "（已压缩）" : "");
      $("dzEmpty").hidden = true;
      $("dzPreview").hidden = false;
    } catch (e) {
      toast("图片读取失败，请换一张试试");
    }
  }

  // 大图自动压缩（≤2MB 原样上传；否则最长边压到 1536px 的 JPEG）
  async function maybeResize(file) {
    if (file.size <= 2 * 1024 * 1024) {
      return { blob: file, url: URL.createObjectURL(file), name: file.name, resized: false };
    }
    var bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      bitmap = await new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }
    var w = bitmap.width, h = bitmap.height;
    var long = Math.max(w, h);
    var scale = long > 1536 ? 1536 / long : 1;
    var cw = Math.max(1, Math.round(w * scale));
    var chh = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = chh;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, cw, chh);
    var blob = await new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, "image/jpeg", 0.92);
    });
    if (!blob || blob.size >= file.size) {
      return { blob: file, url: URL.createObjectURL(file), name: file.name, resized: false };
    }
    return {
      blob: blob,
      url: canvas.toDataURL("image/jpeg", 0.6),
      name: file.name.replace(/\.[^.]+$/, "") + ".jpg",
      resized: true,
    };
  }

  /* ---------------- 密码弹窗 ---------------- */

  var modalResolve = null;

  function openPw(msg) {
    $("pwError").hidden = !msg;
    $("pwError").textContent = msg || "";
    $("pwInput").value = "";
    $("pwModal").hidden = false;
    setTimeout(function () { $("pwInput").focus(); }, 60);
  }
  function closePw(ok) {
    $("pwModal").hidden = true;
    if (modalResolve) { modalResolve(ok); modalResolve = null; }
  }

  $("pwCancel").addEventListener("click", function () { closePw(false); });
  $("pwModal").addEventListener("click", function (e) {
    if (e.target === $("pwModal")) closePw(false);
  });
  $("pwSubmit").addEventListener("click", submitPw);
  $("pwInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitPw();
  });

  async function submitPw() {
    var pw = $("pwInput").value;
    if (!pw) { showPwError("请输入使用密码"); return; }
    $("pwSubmit").disabled = true;
    try {
      var r = await fetch("/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      var j = await r.json();
      if (j.ok) {
        setToken(j.token);
        updateUsage(j.usage);
        closePw(true);
        toast("验证通过，开始创作吧");
      } else {
        showPwError(j.message || "验证失败，请重试");
      }
    } catch (e) {
      showPwError("网络异常，请稍后重试");
    } finally {
      $("pwSubmit").disabled = false;
    }
  }

  function showPwError(msg) {
    $("pwError").hidden = false;
    $("pwError").textContent = msg;
    var card = document.querySelector(".modal-card");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
  }

  /** 确保已通过使用密码验证；未验证则弹窗等待 */
  function ensureToken() {
    if (getToken()) return Promise.resolve(true);
    return new Promise(function (resolve) {
      modalResolve = resolve;
      openPw("");
    });
  }

  /* ---------------- 生成 ---------------- */

  $("generateBtn").addEventListener("click", function () { generate(); });
  $("againBtn").addEventListener("click", function () { generate(); });
  $("prompt").addEventListener("input", function () {
    $("promptCount").textContent = $("prompt").value.length + " / 2000";
  });
  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      $("prompt").value = chip.textContent;
      $("prompt").dispatchEvent(new Event("input"));
      $("prompt").focus();
    });
  });
  $("prompt").addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") generate();
  });

  function setBusy(b) {
    state.busy = b;
    $("generateBtn").disabled = b;
    $("generateBtn").querySelector(".btn-label").textContent = b ? "绘制中…" : "开始创作";
    $("busyBox").hidden = !b;
    if (!b) {
      clearInterval(busyTimer);
      $("imgWrap").hidden = state.current ? false : true;
    } else {
      $("imgWrap").hidden = true;
      busyStart = Date.now();
      busyIdx = 0;
      $("busyWord").textContent = BUSY_WORDS[0];
      $("busyTimer").textContent = "已用时 0 秒 · 生成约需 10–60 秒，请稍候";
      clearInterval(busyTimer);
      busyTimer = setInterval(function () {
        var sec = Math.round((Date.now() - busyStart) / 1000);
        var idx = Math.min(BUSY_WORDS.length - 1, Math.floor(sec / 9));
        $("busyWord").textContent = BUSY_WORDS[idx];
        $("busyTimer").textContent = "已用时 " + sec + " 秒 · 生成约需 10–60 秒，请稍候";
      }, 1000);
    }
  }

  var busyTimer = null, busyStart = 0, busyIdx = 0;

  function showStatus(kind, html) {
    var el = $("status");
    el.hidden = false;
    el.className = "status " + kind;
    el.innerHTML = html;
  }
  function hideStatus() { $("status").hidden = true; }

  async function generate() {
    if (state.busy) return;
    var prompt = $("prompt").value.trim();
    if (!prompt) {
      toast("请先描述你想画的画面");
      $("prompt").focus();
      return;
    }
    var hasImage = !!state.file;

    var ok = await ensureToken();
    if (!ok) return;

    var ch = currentChannel();
    if (!ch) { toast("暂无可用通道，请联系管理员"); return; }

    setBusy(true);
    hideStatus();
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var timeout = setTimeout(function () { if (ctrl) ctrl.abort(); }, 200000);

    try {
      var r, j;
      if (hasImage) {
        var fd = new FormData();
        fd.append("token", getToken());
        fd.append("channelId", state.channelId);
        fd.append("model", state.model);
        fd.append("ratio", state.ratio);
        fd.append("prompt", prompt);
        fd.append("image", state.file, "reference." + (state.file.type === "image/png" ? "png" : state.file.type === "image/webp" ? "webp" : "jpg"));
        r = await fetch("/api/edit", { method: "POST", headers: { "x-access-token": getToken() }, body: fd, signal: ctrl ? ctrl.signal : undefined });
      } else {
        r = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json", "x-access-token": getToken() },
          body: JSON.stringify({ token: getToken(), channelId: state.channelId, model: state.model, ratio: state.ratio, prompt: prompt }),
          signal: ctrl ? ctrl.signal : undefined,
        });
      }
      j = await r.json();
    } catch (e) {
      clearTimeout(timeout);
      setBusy(false);
      var aborted = e && (e.name === "AbortError");
      showStatus("err", "生成超时或网络中断。生成通常需要 10–60 秒，可稍作等待后重试，或更换模型 / 通道。");
      if (aborted) $("busyBox").hidden = true;
      return;
    }
    clearTimeout(timeout);

    if (!j.ok) {
      setBusy(false);
      handleApiError(j, prompt);
      return;
    }

    setBusy(false);
    renderResult(j, prompt);
    updateUsage(j.usage);
    if (j.notice) toast(j.notice, 5200);
  }

  function handleApiError(j, prompt) {
    var msg = j.message || "生成失败，请稍后重试";
    var code = j.code || "";
    var html = msg + (code ? '<span class="code">' + code + "</span>" : "");

    if (code === "E_PASSWORD") {
      setToken("");
      openPw("登录状态已失效，请重新输入使用密码");
    }

    // 通道故障时给出切换建议
    if (["E_QUOTA_CHANNEL", "E_CHANNEL_OFF", "E_CHANNEL_FAIL", "E_UPSTREAM"].indexOf(code) >= 0 && state.cfg) {
      var others = state.cfg.channels.filter(function (c) {
        return c.enabled && c.id !== state.channelId && !c.full;
      });
      if (others.length) {
        html += '<div class="suggest">';
        others.slice(0, 3).forEach(function (c) {
          html += '<button type="button" data-ch="' + c.id + '">改用' + c.name + "重试</button>";
        });
        html += "</div>";
      }
    }
    showStatus("err", html);

    if (code === "E_QUOTA_IP") {
      updateUsage({ used: j.limit || state.cfg.usage.limit, limit: j.limit || state.cfg.usage.limit, remaining: 0 });
    }

    var sugg = document.querySelectorAll("#status .suggest button");
    sugg.forEach(function (btn) {
      btn.addEventListener("click", function () {
        $("channelSelect").value = btn.getAttribute("data-ch");
        $("channelSelect").dispatchEvent(new Event("change"));
        hideStatus();
        generate();
      });
    });
  }

  /* ---------------- 结果展示 ---------------- */

  function imageSrc(img) {
    if (!img) return "";
    return img.kind === "b64"
      ? "data:" + (img.mime || "image/png") + ";base64," + img.b64
      : img.url;
  }

  function renderResult(j, prompt) {
    state.current = {
      src: imageSrc(j.image),
      kind: j.image.kind,
      meta: j.model + " · " + (j.width && j.height ? j.width + "×" + j.height : j.size) + " · " + (j.channel && j.channel.name || "") + " · " + fmtSec(j.elapsedMs) + " 秒",
      notice: j.notice || "",
      revised: j.revisedPrompt || "",
      prompt: prompt,
      ratio: j.ratio,
      model: j.model,
      channelId: j.channel && j.channel.id,
    };
    $("resultZone").hidden = false;
    $("resultMeta").textContent = state.current.meta;
    $("resultImg").src = state.current.src;
    $("imgWrap").hidden = false;
    $("busyBox").hidden = true;

    var extra = $("resultExtra");
    var parts = [];
    if (state.current.notice) parts.push('<div class="notice">' + esc(state.current.notice) + "</div>");
    if (state.current.revised) parts.push('<div class="revised">AI 对画面的理解：' + esc(state.current.revised) + "</div>");
    extra.innerHTML = parts.join("");
    extra.hidden = parts.length === 0;
    $("resultActions").hidden = false;

    state.history.unshift(state.current);
    if (state.history.length > 12) state.history.pop();
    renderHistory();
    $("resultZone").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderHistory() {
    var strip = $("historyStrip");
    strip.innerHTML = "";
    state.history.forEach(function (item, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item" + (item === state.current ? " active" : "");
      var img = document.createElement("img");
      img.src = item.src;
      img.alt = "作品 " + (state.history.length - i);
      img.loading = "lazy";
      btn.appendChild(img);
      btn.title = item.meta;
      btn.addEventListener("click", function () {
        state.current = item;
        $("resultImg").src = item.src;
        $("resultMeta").textContent = item.meta;
        var extra = $("resultExtra");
        var parts = [];
        if (item.notice) parts.push('<div class="notice">' + esc(item.notice) + "</div>");
        if (item.revised) parts.push('<div class="revised">AI 对画面的理解：' + esc(item.revised) + "</div>");
        extra.innerHTML = parts.join("");
        extra.hidden = parts.length === 0;
        renderHistory();
      });
      strip.appendChild(btn);
    });
  }

  /* ---------------- 下载 / 打开 ---------------- */

  $("downloadBtn").addEventListener("click", async function () {
    if (!state.current) return;
    var name = "一画-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
    if (state.current.kind === "b64") {
      var a = document.createElement("a");
      a.href = state.current.src;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    try {
      var r = await fetch(state.current.src);
      if (!r.ok) throw new Error("http " + r.status);
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) {
      window.open(state.current.src, "_blank");
      toast("已在新窗口打开图片，请右键另存");
    }
  });

  $("openBtn").addEventListener("click", function () {
    if (!state.current) return;
    window.open(state.current.src, "_blank");
  });

  init();
})();
