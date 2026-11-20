// 上游接口探测：验证尺寸支持、返回结构、edits 多部分上传（少量真实调用）
import fs from "node:fs";
import fsp from "node:fs/promises";

const KEY = process.env.YIHUA_PROBE_KEY || "sk-15852f55319342769f613499cec2c782e8d2ff357a638a034f1ed214f7d0402f";
const BASE = "https://api.freeshengtu.com";

async function gen(size, prompt) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + "/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: "gpt-image-2", prompt, n: 1, size }),
      signal: AbortSignal.timeout(170000),
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch {}
    const item = j && Array.isArray(j.data) ? j.data[0] : null;
    return {
      size, status: r.status, ms: Date.now() - t0,
      topKeys: j ? Object.keys(j) : null,
      itemKeys: item ? Object.keys(item) : null,
      b64Len: item && item.b64_json ? item.b64_json.length : 0,
      hasUrl: !!(item && item.url),
      err: r.ok ? null : txt.slice(0, 400),
      b64: item && item.b64_json ? item.b64_json : null,
    };
  } catch (e) {
    return { size, status: 0, ms: Date.now() - t0, err: "NETWORK: " + (e && e.message || e) };
  }
}

function stripB64(r) { const { b64, ...rest } = r; return rest; }

const results = [];
console.log("== 测试 1: 1024x1024 基准 ==");
results.push(await gen("1024x1024", "极简测试图：纯白背景上一个红色圆形，扁平插画"));
console.log(JSON.stringify(stripB64(results[0]), null, 2));

const first = results[0];
if (first.b64) {
  await fsp.writeFile("/tmp/probe-1.png", Buffer.from(first.b64, "base64"));
  console.log("已保存 /tmp/probe-1.png, 文件字节:", fs.statSync("/tmp/probe-1.png").size);
}

console.log("== 测试 2: 1536x1152 (4:3 非标准尺寸) ==");
results.push(await gen("1536x1152", "极简测试图：纯白背景上一个蓝色方形，扁平插画"));
console.log(JSON.stringify(stripB64(results[1]), null, 2));

console.log("== 测试 3: 1792x768 (21:9 非标准尺寸) ==");
results.push(await gen("1792x768", "极简测试图：纯白背景上一个绿色三角形，扁平插画"));
console.log(JSON.stringify(stripB64(results[2]), null, 2));

console.log("== 测试 4: /v1/images/edits 多部分表单 ==");
if (first.b64) {
  try {
    const buf = await fsp.readFile("/tmp/probe-1.png");
    const fd = new FormData();
    fd.append("model", "gpt-image-2");
    fd.append("prompt", "把这个红色圆形改成黄色，其余不变");
    fd.append("n", "1");
    fd.append("size", "1024x1024");
    fd.append("image", new Blob([buf], { type: "image/png" }), "probe-1.png");
    const t0 = Date.now();
    const r = await fetch(BASE + "/v1/images/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: fd,
      signal: AbortSignal.timeout(170000),
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    const item = j && Array.isArray(j.data) ? j.data[0] : null;
    console.log(JSON.stringify({
      status: r.status, ms: Date.now() - t0,
      itemKeys: item ? Object.keys(item) : null,
      b64Len: item && item.b64_json ? item.b64_json.length : 0,
      hasUrl: !!(item && item.url),
      err: r.ok ? null : txt.slice(0, 400),
    }, null, 2));
  } catch (e) {
    console.log("edits 网络错误:", e && e.message || e);
  }
} else {
  console.log("跳过（基准生成失败）");
}

console.log("== 完成 ==");
