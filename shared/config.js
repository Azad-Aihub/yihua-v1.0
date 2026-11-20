// 一画 · 共享配置（所有部署平台共用）
export const APP_VERSION = "1.0.0";

export const BRAND = {
  name: "一画",
  en: "AI IMAGE STUDIO",
  tagline: "一句话，一张画。",
  desc: "用日常的语言描述画面，AI 为你绘制；也可以上传一张照片，让它照着改。",
};

// 默认设置（首次启动时写入存储；均可后续在管理后台修改）
export const DEFAULT_SETTINGS = {
  // 访客使用密码（部署后请立即在管理后台或环境变量中修改）
  accessPassword: "yihua2026",
  // 管理后台密码（部署后请立即修改）
  adminPassword: "yihua-admin-2026",
  // 每位访客（按 IP）每日可成功生成的张数
  perIpDailyLimit: 10,
  // 公告（显示在创作面板上方，留空则不显示）
  announcement: "",
};

// 默认通道（首次启动时写入存储；请在管理后台维护）
export const DEFAULT_CHANNELS = [
  {
    id: "ch1",
    name: "通道一",
    baseUrl: "https://api.freeshengtu.com",
    apiKey: "sk-15852f55319342769f613499cec2c782e8d2ff357a638a034f1ed214f7d0402f",
    enabled: true,
    dailyLimit: 0, // 0 表示不限制（仅受全站每 IP 限额约束）
    models: [
      "gpt-image-2",
      "gpt-image-2.5",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.6",
      "gpt-image-2.6-flare",
      "gpt-image-2.6-sunburst",
    ],
  },
];

// 画幅比例 → 实际像素尺寸（全部经过上游实测支持）
export const RATIOS = [
  { id: "1:1", w: 1024, h: 1024, label: "方形" },
  { id: "2:3", w: 1024, h: 1536, label: "竖版" },
  { id: "3:2", w: 1536, h: 1024, label: "横版" },
  { id: "4:3", w: 1536, h: 1152, label: "传统" },
  { id: "3:4", w: 1152, h: 1536, label: "传统" },
  { id: "16:9", w: 1536, h: 864, label: "宽屏" },
  { id: "9:16", w: 864, h: 1536, label: "全屏" },
  { id: "21:9", w: 1792, h: 768, label: "超宽" },
  { id: "9:21", w: 768, h: 1792, label: "长幅" },
  { id: "auto", w: 0, h: 0, label: "AI 自动" },
];

export const CONFIG_KEY = "cfg:v1";
export const MAX_PROMPT_LEN = 2000;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB（前端会自动压缩参考图）
export const MAX_CHANNELS = 6;
export const TOKEN_TTL_DAYS = 30; // 访客验证有效期（天）
export const ADMIN_TTL_DAYS = 7; // 管理登录有效期（天）
export const UPSTREAM_TIMEOUT_MS = 170000;
export const PW_FAIL_LIMIT = 10; // 密码连续错误上限（每小时）
