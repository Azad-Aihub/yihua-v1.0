# 一画 · AI Image Studio

> 一句话，一张画。用日常的语言描述画面，AI 为你绘制；也可以上传一张照片，让它照着改。

一个可直接部署到 **Cloudflare Workers / Vercel / 腾讯 EdgeOne Pages**（任选其一，全免费额度可用）的 AI 生图站点，自带访客密码门、按 IP 每日限额、多通道调度与管理后台。

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 文生图 | `/v1/images/generations`，提示词 + 10 种画幅（1:1、2:3、3:2、4:3、3:4、16:9、9:16、21:9、9:21、AI 自动） |
| 图生图 | `/v1/images/edits`，上传参考图（前端自动压缩），AI 照着改 |
| 使用密码 | 访客首次创作需输入密码，验证一次 30 天免输入（服务端签发令牌，非明文存储） |
| IP 限额 | 每位访客每日按**成功出图**计数限额（默认 10 张，管理后台可改 1–100） |
| 多通道 | 通道一/二/三…（最多 6 个），可启停、可设每通道每日限额、可自定义对外开放的模型；通道失效时访客可一键切换 |
| 管理后台 | `/admin`：通道增删改、密钥管理、限额、公告、密码修改、连通性测试 |
| 存储 | Cloudflare KV / EdgeOne KV / Upstash Redis（免费）任选，未配置时自动降级为内存模式 |
| 密钥安全 | API Key 只保存在服务端，前端与公开接口永不接触密钥 |

## 目录结构

```
yihua/
├── public/                  # 前端静态资源（三平台共用，无构建步骤）
│   ├── index.html           # 访客界面
│   ├── admin.html           # 管理后台
│   ├── favicon.svg
│   └── assets/{style.css, app.js, admin.js}
├── shared/                  # 核心业务逻辑（三平台共用同一份）
│   ├── app.js               # 路由与全部业务（鉴权/限额/通道/代理）
│   ├── config.js            # 默认配置、比例表
│   ├── storage.js           # 存储适配器（CF KV / EdgeOne KV / Upstash / 内存）
│   ├── util.js              # 令牌、哈希、IP、尺寸计算
│   └── mock.js              # 模拟上游（本地演示用）
├── worker/index.js          # Cloudflare Workers 入口
├── api/[[...path]].js       # Vercel Serverless 入口
├── functions/               # EdgeOne Pages Functions 入口（兼容 CF Pages）
├── local/server.js          # 本地预览服务器
├── scripts/test-unit.mjs    # 单元测试（27 项）
├── wrangler.jsonc           # Cloudflare 配置
├── vercel.json              # Vercel 配置
├── .env.example             # 环境变量示例
└── 部署教程.md               # 小白部署教程（三平台）
```

## 本地预览（可选，1 分钟）

要求 Node.js ≥ 18。

```bash
npm run dev          # http://localhost:8787 （模拟上游，不消耗真实额度）
# 或调用真实接口调试：
YIHUA_USE_REAL_UPSTREAM=1 npm run dev
```

- 默认访客使用密码：`yihua2026`；管理密码：`yihua-admin-2026`（部署后请立即修改）
- 管理后台：http://localhost:8787/admin
- 运行测试：`npm test`

## 三平台一键部署

详细图文步骤见 **[部署教程.md](./部署教程.md)**，速览：

| 平台 | 方式 | 需要准备 |
| --- | --- | --- |
| Cloudflare（推荐） | Git 连接或 `npx wrangler deploy` | 创建一个 KV 命名空间（`YIHUA_KV`）并把 id 填入 wrangler.jsonc |
| Vercel | Git 导入 | 建议配 Upstash Redis（免费）持久化限额 |
| 腾讯 EdgeOne Pages | Git 导入 | 创建 KV 命名空间并绑定变量名 `YIHUA_KV` |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `ACCESS_PASSWORD` | 访客使用密码（优先于管理后台保存的密码） |
| `ADMIN_PASSWORD` | 管理后台密码（优先于管理后台保存的密码） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis 凭证（Vercel 建议配置） |

## 错误码对照

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `E_INPUT` | 提示词为空/过长、模型未开放 | 按提示修改 |
| `E_PASSWORD` | 使用密码错误或登录失效 | 重新输入密码 |
| `E_QUOTA_IP` | 今日个人额度用完 | 明天再来 / 后台调高限额 |
| `E_QUOTA_CHANNEL` | 所选通道额度已满 | 切换其他通道 |
| `E_CHANNEL_OFF` | 通道停用或不存在 | 切换其他通道 |
| `E_CHANNEL_FAIL` | 无法连接通道服务器 | 检查通道地址 / 稍后再试 |
| `E_UPSTREAM` | 上游返回错误（附 HTTP 状态） | 见界面提示 / 换通道 |
| `E_IMAGE` | 参考图格式或大小不符 | 用 PNG/JPG/WebP |
| `E_ADMIN` / `E_CONFIG` | 管理登录失效 / 配置不合法 | 重新登录 / 按提示修正 |

## 免费额度参考

- **Cloudflare**：Workers 免费 10 万请求/天；KV 免费每天约 1000 次写入，本站每次成功生图写 2 次（IP 计数 + 通道计数），约可支撑每天 500 张成功出图，读取量远够。
- **Vercel**：Hobby 函数单次最长 300 秒（生图 25–60 秒绰绰有余）；请求/响应体上限 4.5MB（前端已自动压缩参考图）。
- **EdgeOne Pages**：KV 免费账户 1GB 存储，计数器带惰性过期。
