// dsh-commandcode-quota: CLIENT half — Command Code 余额额度仪表盘 (v3 可读性修复版)。
//
// 在 composer dock 槽位挂一行常驻额度状态栏; 点击展开仪表盘面板:
//   - Hero: 余额大数字 + 订阅状态徽章
//   - 限额: 每月 / 5小时 / 每周 进度卡片 (used vs cap + 重置时间)
//   - 用量: 三格统计卡片 (总消耗 / 请求数 / tokens)
//   - 底部: 账户信息 + 数据时间
//
// v3 修复: 进度条之前用 `${var}` 拼接透明度后缀产生非法 CSS 导致填充色
// 不渲染 (进度条看不见); 全部改用 color-mix() 派生透明度; 色板对齐 DSH
// 深色主题层次, 提高文字对比。每月窗口由 usage.totalMonthlyCredits(已用)
// + balance.monthlyCredits(剩余) 合成, 重置时间取订阅周期末。
window.__ModuleLoader__.load({
  id: "dsh-commandcode-quota",
  factory: (require) => {
    const React = require("react");
    const { useCallback, useEffect, useState, useRef } = React;

    const FETCH_URL = "/__dsh-commandcode-quota/dashboard";
    const CREDENTIALS_URL = "/__dsh-commandcode-quota/credentials";
    // 分层轮询: credits(余额)轻量, 3 分钟一次; usage/subscriptions 是重查询, 30 分钟一次。
    // 页面不可见时整轮跳过, 切回前台立即补一次 —— 免得后台白打上游接口。
    const QUICK_REFRESH_MS = 3 * 60 * 1000;
    const FULL_REFRESH_MS = 30 * 60 * 1000;

    // 接口名 → 中文, 用于把宿主端返回的 errors 展示成人能读懂的话
    const ENDPOINT_NAMES = { credits: "余额", usage: "用量", subscriptions: "订阅", whoami: "账户" };

    // ---- 格式化 --------------------------------------------------------------

    function fmtCurrency(value, digits = 2) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return "$" + value.toFixed(digits);
    }

    // 不设 G 档: token 计量惯例是 K/M, 2.56e9 应显示为 2560.5M 而不是 2.56G。
    function fmtNumber(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
      if (value >= 1e3) return (value / 1e3).toFixed(1) + "K";
      return String(Math.round(value));
    }

    function fmtDate(ms) {
      const t = toMs(ms);
      if (!t) return "—";
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // 统一转时间戳: API 里 resetAt 是数字毫秒, createdAt/currentPeriodStart/currentPeriodEnd 是 ISO 字符串
    function toMs(ms) {
      if (typeof ms === "number" && Number.isFinite(ms)) return ms;
      if (typeof ms === "string" && ms.length > 0) {
        const t = Date.parse(ms);
        return Number.isFinite(t) ? t : null;
      }
      return null;
    }

    // 短日期: 年/月/日
    function fmtDay(ms) {
      const t = toMs(ms);
      if (!t) return "—";
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    }

    // 从 fromMs 到现在经过了多久: "15 天 3 小时" / "3 小时 25 分" / "25 分钟"
    function fmtElapsed(fromMs) {
      const t = toMs(fromMs);
      if (!t) return "—";
      const diff = Date.now() - t;
      if (diff < 0) return "未开始";
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      if (days > 0) return `${days} 天 ${hours} 小时`;
      if (hours > 0) return `${hours} 小时 ${mins} 分`;
      return `${Math.max(1, mins)} 分钟`;
    }

    function fmtDuration(fromMs) {
      const t = toMs(fromMs);
      if (t === null) return "—";
      if (t <= Date.now()) return "已重置";
      const diff = t - Date.now();
      const days = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      if (days > 0) return `${days}天${h}小时`;
      if (h > 0) return `${h}小时${m}分`;
      // 不足 1 小时时精确到秒没有意义, 让人读到"47 分钟"就够了
      return `${Math.max(1, m)} 分钟`;
    }

    // 到期日与今天不同时补上日期, 同时回答"还有多久"和"哪天到期"
    function fmtResetDay(ms) {
      const t = toMs(ms);
      if (t === null || t <= Date.now()) return "";
      const day = fmtDay(t);
      return day === fmtDay(Date.now()) ? "" : `（${day}）`;
    }

    // ---- 主题 token (对齐 DSH 深色主题层次) -----------------------------------
    // 深色主题: bg-layer-1=rgb(35,35,36) / layer-2=rgb(44,44,46) /
    // layer-3=rgb(53,54,56) / label-primary=rgb(249,250,251) /
    // label-secondary=rgb(207,211,214) / label-tertiary=rgb(173,178,184)
    // 浅色主题由变量自动切换; 进度条/徽章的透明色一律用 color-mix 派生,
    // 绝不在 var() 后面拼十六进制透明度 (非法 CSS)。

    const T = {
      bg: "var(--dsw-alias-bg-layer-1, #232324)",
      // 不要用 --dsw-alias-brand-primary: 它只是个 neutral 色阶别名,
      // 卡片底色: 从 layer-1 只混 6% 主文字色 —— 混多了是一块突兀的亮灰,
      // 照搬 layer-2 又可能换肤后和 layer-1 同色糊成一片。6% + 1px 边框刚好。
      bg2: "color-mix(in srgb, var(--dsw-alias-bg-layer-1, #232324) 96%, var(--dsw-alias-label-primary, #f9fafb) 4%)",
      border: "var(--dsw-alias-border-l2, rgba(255,255,255,.14))",
      borderL: "var(--dsw-alias-border-l1, rgba(255,255,255,.08))",
      // 卡片描边自己派生: 浅色主题下主题的 border-l1 偏重(实测 #c4c5c6),
      // 1px 就能把面板描得发脏; 10% 主文字色在两种主题下都刚好是一条淡线。
      hairline: "color-mix(in srgb, var(--dsw-alias-label-primary, #f9fafb) 10%, transparent)",
      label: "var(--dsw-alias-label-primary, #f9fafb)",
      label2: "var(--dsw-alias-label-secondary, #d3d5d9)",
      label3: "var(--dsw-alias-label-tertiary, #adb2b8)",
      success: "var(--dsw-alias-state-success-primary, #22c55e)",
      warn: "var(--dsw-alias-state-warn-primary, #f59e0b)",
      error: "var(--dsw-alias-state-error-primary, #f25a5a)",
      // 进度色用 Anthropic 官方柔和蓝 #6A9BCC: 低饱和, 深色底上不刺眼,
      // 又天然和告警的琥珀 / 红分开。不能用 --dsw-alias-brand-primary
      // (它只是中性色阶别名, 换肤后会整条变黑)。
      brand: "#6A9BCC",
    };

    // 进度条轨道: 从主文字色派生 10% 透明度 —— 深色主题得浅色轨道, 浅色主题得深色轨道,
    // 不依赖 interactive-bg-hover(换肤后可能和背景同色, 轨道直接消失)。
    const TRACK_STYLE = "color-mix(in srgb, var(--dsw-alias-label-primary, #f9fafb) 10%, transparent)";

    // 原生 select 的下拉箭头替身(SVG data URI), 盖掉浏览器默认控件外观
    const SELECT_CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23adb2b8' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

    // ---- 样式常量 -------------------------------------------------------------

    // 面板: 由 shellStyle 的绝对定位容器承载, 从状态栏上方展开(不再是右下角浮层)
    const shellStyle = {
      width: 352,
      maxWidth: "calc(100vw - 40px)",
      maxHeight: "calc(100vh - 120px)",
      pointerEvents: "auto",
      zIndex: 9999,
      fontFamily: "inherit",
      color: T.label,
      borderRadius: 14,
      background: T.bg,
      border: `1px solid ${T.border}`,
      boxShadow: "0 18px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.25)",
      overflowY: "auto",
      overflowX: "hidden",
      animation: "ccUsagePop .22s cubic-bezier(.2,.9,.3,1.2)",
    };

    // 额度读数: 常驻在输入框下方 dock, 刻意对齐官方 stats 药丸的规格。
    // 官方规格见 @deepseek-ai/dsh-client-ui-chat 的 StatsPills.module.css:
    //   .iq1doa_pill{ color:label-tertiary; border-radius:999px; gap:6px; padding:1px 8px;
    //                 background:0 0 }                      ← 平时**无底色**
    //   button.iq1doa_pill:hover,button.iq1doa_pill[aria-expanded=true]{
    //                 background:var(--dsw-alias-interactive-bg-hover); color:label-secondary }
    // 即: 灰底只在 hover / 展开时出现, 不是常驻。
    const badgeStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      // 间距交给父容器的 gap(官方 dock gap = 12), 这里不再额外加 margin,
      // 否则会变成 12+12=24, 比官方胶囊之间宽一倍。
      padding: "1px 8px",
      borderRadius: 999,
      pointerEvents: "auto",
      cursor: "pointer",
      border: "none",
      // 平时透明, hover 时由事件处理器浮出灰底(见下方 onMouseEnter)
      background: "transparent",
      color: T.label3,
      fontFamily: "inherit",
      fontSize: 12,
      lineHeight: "20px",
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "nowrap",
      transition: "background .15s ease, color .15s ease",
    };

    // 只作定位锚点: 宽度自适应(不撑满整行, 否则会挤开官方统计), 面板相对它向上展开
    const statusBarStyle = {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      pointerEvents: "none",
    };

    // 由 shellStyle 承载的定位/动画补充: 从状态栏上方展开, 左边缘与读数对齐
    const panelPosStyle = {
      position: "absolute",
      bottom: "calc(100% + 8px)",
      left: 8,
      pointerEvents: "auto",
    };

    // ---- 内联 SVG 图标 ----------------------------------------------------------

    // 空心闪电: 对齐官方 outline 图标规格 (fill:none + stroke:currentColor + strokeWidth:1, 16x16 视图盒显示 14px)。
    // 原来是实心 fill="currentColor", 所以看起来又深又重, 和官方空心图标不是一套。
    const IconBolt = () => React.createElement("svg", {
      width: 14,
      height: 14,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
      React.createElement("path", { d: "M8.9 1.5 3.2 9.2h4.1l-.9 5.3 6.4-8h-4.2l.3-5z" }));

    const IconRefresh = () => React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" },
      React.createElement("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
      React.createElement("polyline", { points: "21 3 21 8 16 8" }));

    const IconClose = () => React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" },
      React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
      React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" }));

    // 齿轮: 凭据设置入口(默认收起, 不占主面板)
    const IconGear = () => React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
      React.createElement("circle", { cx: 12, cy: 12, r: 3 }),
      React.createElement("path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.38.4.7.78.86H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" }));

    const IconClock = ({ color }) => React.createElement("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round" },
      React.createElement("circle", { cx: "12", cy: "12", r: "9" }),
      React.createElement("polyline", { points: "12 7 12 12 15 14" }));

    const IconCalendar = ({ color }) => React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: color || "currentColor", strokeWidth: 2, strokeLinecap: "round" },
      React.createElement("rect", { x: "3", y: "5", width: "18", height: "16", rx: "2" }),
      React.createElement("line", { x1: "3", y1: "10", x2: "21", y2: "10" }),
      React.createElement("line", { x1: "8", y1: "2.5", x2: "8", y2: "6" }),
      React.createElement("line", { x1: "16", y1: "2.5", x2: "16", y2: "6" }));

    // ---- 通用小组件 --------------------------------------------------------------

    function StatCard({ label, value, sub, accent }) {
      return React.createElement("div", {
        style: {
          flex: 1,
          minWidth: 0,
          background: T.bg2,
          border: `1px solid ${T.borderL}`,
          borderRadius: 10,
          padding: "10px 11px",
        },
      },
        React.createElement("div", { style: { fontSize: 11, color: T.label3, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, label),
        React.createElement("div", {
          style: {
            fontSize: 15.5,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            color: accent || T.label,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            letterSpacing: "-.2px",
          },
        }, value),
        sub ? React.createElement("div", { style: { fontSize: 11, color: T.label3, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, sub) : null);
    }

    // 三档状态灯: 当前档亮起, 其余压暗。
    // 数据来自官方字段 credits.belowThreshold / usage.windowLimits.*.exceeded;
    // 这三个人话名字是给那两条数据起的, 不是官方术语 —— 悬停每个灯都有解释。
    const STATUS_LEVELS = [
      { key: "ok", label: "正常", hint: "余额充足，三个额度窗口都没用满", color: T.success },
      { key: "low", label: "余额低", hint: "余额已低于你设定的告警阈值（threshold）", color: T.warn },
      { key: "out", label: "已用尽", hint: "有额度窗口已经用满，等它按 5 小时 / 每周 / 每月重置", color: T.error },
    ];

    // 可选配色: 只改"低用量起点色"; 用量一高, 仍然统一走向暖色和红。
    const PALETTES = [
      { key: "mist", label: "雾蓝", hex: "#6A9BCC" },
      { key: "indigo", label: "靛蓝", hex: "#5E6AD2" },
      { key: "steel", label: "灰蓝", hex: "#7C9CBF" },
      { key: "teal", label: "青绿", hex: "#2E9E8A" },
      { key: "lilac", label: "丁香", hex: "#8B7BB8" },
      { key: "clay", label: "陶土", hex: "#D97757" },
    ];
    const PALETTE_STORAGE_KEY = "dsh-commandcode-quota:palette";

    function hexToRgb(hex) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
      if (!m) return [106, 155, 204];
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    /** 用量 → 颜色。起点由所选配色决定; 55% 之前保持冷静, 之后升温, 100% 收在红。 */
    function usageColor(pct, brandHex) {
      const base = hexToRgb(brandHex);
      const stops = [
        [0, base],
        [55, base],
        [70, [217, 164, 65]],
        [85, [217, 119, 87]],
        [100, [201, 79, 79]],
      ];
      const p = Math.max(0, Math.min(100, pct));
      for (let i = 1; i < stops.length; i++) {
        const [p1, c1] = stops[i];
        if (p <= p1) {
          const [p0, c0] = stops[i - 1];
          const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0);
          const rgb = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
          return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
        }
      }
      return "rgb(201, 79, 79)";
    }

    // 进度条: 颜色随用量走, 条形内部还有一段 40 个百分点的渐变 —
    // 高用量时能直接看出"冷 → 暖"的推进。消耗 > 0 时至少露出 3px。
    function Bar({ pct, height = 8, forceColor, brand }) {
      const clamped = Math.max(0, Math.min(100, pct || 0));
      const end = forceColor || usageColor(clamped, brand);
      const start = forceColor || usageColor(Math.max(0, clamped - 40), brand);
      return React.createElement("div", {
        style: {
          height,
          borderRadius: 99,
          background: TRACK_STYLE,
          overflow: "hidden",
          boxShadow: "inset 0 1px 2px rgba(0,0,0,.12)",
        },
      },
        React.createElement("div", {
          style: {
            width: clamped > 0 ? `max(${clamped}%, 3px)` : "0%",
            height: "100%",
            borderRadius: 99,
            background: `linear-gradient(90deg, ${start}, ${end})`,
            transition: "width .45s cubic-bezier(.3,.8,.3,1)",
          },
        }));
    }

    // 状态徽章: 颜色由服务端告警位决定, 不再永远绿色 active。
    const BADGE_TONES = { success: T.success, warn: T.warn, error: T.error };
    function StatusBadge({ tone, label }) {
      const color = BADGE_TONES[tone] ?? T.success;
      return React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: `color-mix(in srgb, ${color} 15%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
          color,
          borderRadius: 99,
          padding: "4px 11px",
          fontSize: 11.5,
          fontWeight: 600,
          whiteSpace: "nowrap",
        },
      },
        React.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" } }),
        label);
    }

    // 统一错误卡片: 顶部错误态与「余额字段缺失」态共用,
    // 后者以前直接 return null, 于是查询失败被渲染成一块空白面板。
    function ErrorBox({ text }) {
      return React.createElement("div", {
        style: {
          margin: "16px",
          padding: "12px 14px",
          whiteSpace: "pre-line",
          background: "color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 14%, transparent)",
          border: "1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 38%, transparent)",
          borderRadius: 12,
          fontSize: 12.5,
          color: T.error,
          lineHeight: 1.6,
        },
      }, String(text));
    }

    // 一个额度窗口 = 一张卡: 名称 + 百分比 / 进度条 / 一行明细。
    // 明细压成一行(已用/上限 · 剩余 · 重置), 信息不丢但高度减半。
    function QuotaRow({ title, used, cap, resetAt, exceeded, brand, note }) {
      const capSafe = cap > 0 ? cap : (used > 0 ? used : 1);
      const pct = capSafe > 0 ? Math.min(100, (used / capSafe) * 100) : 0;
      const exhausted = exceeded === true;
      // 颜色交给进度条表达(随用量连续变化), 数字保持主文字色, 只在用尽时转红 ——
      // 浅色主题下黄/橙数字对比度不够, 读起来会糊。
      const pctColor = exhausted ? T.error : T.label;
      const remaining = Math.max(0, capSafe - used);
      return React.createElement("div", {
        style: {
          background: T.bg2,
          borderRadius: 12,
          padding: "10px 13px 11px",
          // 几乎同色的底 + 一条极细边框: 靠线和间距分组, 而不是靠一块亮灰
          border: `1px solid ${T.hairline}`,
        },
      },
        React.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, fontSize: 12, color: T.label2 } },
          React.createElement("span", { style: { fontWeight: 600 } },
            title,
            exhausted ? React.createElement("span", { style: { marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: T.error } }, "已用尽") : null),
          React.createElement("span", { style: { fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: pctColor, letterSpacing: "-.3px" } },
            (Math.round(pct * 10) / 10) + "%")),
        React.createElement("div", { style: { margin: "8px 0 7px" } },
          React.createElement(Bar, { pct, brand, forceColor: exhausted ? T.error : null })),
        // 固定两行: 一行放"已用/上限", 一行放"剩余/重置"。
        // 挤成一行时日期会被断到下一行, 比多一行更难看。
        React.createElement("div", { style: { fontSize: 11, color: T.label3, lineHeight: 1.55, fontVariantNumeric: "tabular-nums" } },
          `已用 ${fmtCurrency(used)} / 上限 ${fmtCurrency(capSafe)}`),
        React.createElement("div", { style: { fontSize: 11, color: T.label3, lineHeight: 1.55, fontVariantNumeric: "tabular-nums" } },
          `剩余 ${fmtCurrency(remaining)} · `
            + (exhausted ? `${fmtDuration(resetAt)}后重置` : `重置 ${fmtDuration(resetAt)}${fmtResetDay(resetAt)}`)),
        // 超额预警: 只有"按当前日均撑不到重置"时才多出这一行
        note ? React.createElement("div", { style: { marginTop: 4, fontSize: 11, color: T.warn, lineHeight: 1.5 } }, `⚠ ${note}`) : null);
    }

    // ---- 凭据条目选择 ------------------------------------------------------------
    //
    // 这个选择器在整个面板里【恒定渲染】—— 加载中、报错、甚至完全没数据时都在。
    // 因为「一个 key 都没配」正是最需要它的时刻：用户在这里选一个已有条目即可，
    // 不必去手改 profile patch。

    function CredentialPicker({ state, onPick }) {
      const safe = state || {};
      const raw = Array.isArray(safe.entries) ? safe.entries : [];
      // entries 是 [{ ref, provider }]；同时容忍纯字符串（宿主端读不到供应商时）
      const entries = raw
        .map((e) => (typeof e === "string" ? { ref: e, provider: null } : e))
        .filter((e) => e && typeof e.ref === "string" && e.ref.length > 0);
      const current = safe.apiKeyEnv ?? null;
      // 当前值可能不在候选里（配置指向了尚未添加的条目），补一项，避免下拉显示空白
      const options = current && !entries.some((e) => e.ref === current)
        ? [{ ref: current, provider: null }, ...entries]
        : entries;
      // 能对上模型供应商时显示「供应商（条目名）」，否则只显示条目名
      const labelOf = (e) => (e.provider ? `${e.provider}（${e.ref}）` : e.ref);

      return React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px 9px",
          borderBottom: `1px solid ${T.borderL}`,
          fontSize: 11.5,
          color: T.label3,
        },
      },
        React.createElement("span", { style: { whiteSpace: "nowrap" } }, "凭据条目"),
        React.createElement("select", {
          value: current ?? "",
          disabled: Boolean(safe.saving),
          title: "选择用哪条凭据查询额度",
          onChange: (event) => onPick(event.target.value),
          style: {
            flex: 1,
            minWidth: 0,
            padding: "4px 24px 4px 8px",
            fontSize: 11.5,
            fontFamily: "inherit",
            color: T.label2,
            background: T.bg2,
            backgroundImage: SELECT_CHEVRON,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 7px center",
            appearance: "none",
            WebkitAppearance: "none",
            border: `1px solid ${T.borderL}`,
            borderRadius: 7,
            cursor: safe.saving ? "default" : "pointer",
          },
        },
          React.createElement("option", { value: "" }, "（未设置）"),
          options.map((e) => React.createElement("option", { key: e.ref, value: e.ref }, labelOf(e)))),
        safe.saving ? React.createElement("span", null, "…") : null,
        safe.error ? React.createElement("span", { style: { color: T.error } }, safe.error) : null);
    }

    // ---- 面板内容 ----------------------------------------------------------------

    function DashboardBody({ data, loading, error, palette }) {
      if (error) return React.createElement(ErrorBox, { text: error });
      if (loading && !data) {
        // 骨架屏: 按真实布局占位(余额块 + 三张卡), 数据回来时不会整块"跳一下"
        const bone = (key, w, h, mb) => React.createElement("div", {
          key,
          // 占位条要比卡片底色更实一点, 否则和卡片同色会"消失"
          style: { width: w, height: h, borderRadius: 6, background: T.hairline, marginBottom: mb },
        });
        return React.createElement("div", {
          key: "skeleton",
          style: { padding: "14px 16px 12px" },
          "aria-busy": true,
          "aria-label": "正在获取额度",
        },
          bone("b1", "34%", 9, 10),
          bone("b2", "48%", 26, 12),
          bone("b3", "72%", 9, 6),
          bone("b4", "58%", 9, 6),
          bone("b5", "64%", 9, 14),
          [0, 1, 2].map((i) => React.createElement("div", {
            key: "sk" + i,
            style: {
              background: T.bg2,
              borderRadius: 12,
              border: `1px solid ${T.hairline}`,
              padding: "12px 13px",
              marginBottom: i === 2 ? 0 : 9,
            },
          },
            bone("s" + i + "a", "40%", 9, 10),
            bone("s" + i + "b", "100%", 8, 9),
            bone("s" + i + "c", "76%", 9, 5),
            bone("s" + i + "d", "52%", 9, 0))),
          React.createElement("div", { style: { marginTop: 12, textAlign: "center", fontSize: 11, color: T.label3 } }, "正在获取额度…"));
      }
      if (!data) return null;
      // 余额字段缺失(最常见的是 credits 单接口 401/500)时必须说清原因,
      // 不能再 return null —— 那会把「查询失败」伪装成一块空白面板。
      if (!data.balance) {
        const failed = Array.isArray(data.errors) ? data.errors : [];
        const detail = failed.length > 0
          ? failed.map((e) => `${ENDPOINT_NAMES[e.endpoint] ?? e.endpoint}: ${e.message}`).join("\n")
          : "服务端没有返回余额数据（点右上角 ⟳ 重试）";
        return React.createElement(ErrorBox, { text: `额度查询失败\n${detail}` });
      }

      const { balance, windowLimits, usage, subscription, user } = data;

      // 订阅开通时间: 优先 createdAt, 回退到当前周期开始
      const subSince = subscription && (subscription.createdAt || subscription.currentPeriodStart) || null;

      // ---- 服务端告警位 --------------------------------------------------------
      // API 已经把「余额低于阈值 / 窗口已用尽 / 订阅已取消续费」判好了, 之前一个都没用,
      // 于是额度真的用尽时面板还是那个绿色 active 徽章 —— 在最该报警的时刻显得一切正常。
      const belowThreshold = balance.belowThreshold === true;
      const exhaustedNames = [];
      if (windowLimits && windowLimits.fiveHour && windowLimits.fiveHour.exceeded === true) exhaustedNames.push("5 小时");
      if (windowLimits && windowLimits.weekly && windowLimits.weekly.exceeded === true) exhaustedNames.push("每周");
      if (windowLimits && windowLimits.exceeded === true && exhaustedNames.length === 0) exhaustedNames.push("额度");
      // 状态档位: 任一窗口用尽 > 余额低于阈值 > 正常
      const statusLevel = exhaustedNames.length > 0 ? "out" : belowThreshold ? "low" : "ok";
      const brandHex = (palette && palette.hex) || PALETTES[0].hex;

      // 本次请求里订阅接口是否失败(接口本身慢/超时) —— 用于区分"没这条数据"和"没取到"
      const subFailed = Array.isArray(data.errors)
        && data.errors.some((e) => e && e.endpoint === "subscriptions");
      const staleList = Array.isArray(data.stale) ? data.stale : [];

      // 月度窗口: usage.totalMonthlyCredits(本周期已用月度积分) +
      // balance.monthlyCredits(剩余月度积分) = 周期总额度
      const monthUsed = usage && typeof usage.totalMonthlyCredits === "number" ? usage.totalMonthlyCredits : null;
      const monthCap = monthUsed !== null && balance.monthlyCredits !== undefined
        ? monthUsed + balance.monthlyCredits
        : null;
      const monthReset = subscription && subscription.currentPeriodEnd ? subscription.currentPeriodEnd : null;

      // 日均消耗: 本周期已用 ÷ 本周期已过天数(periodStart 由 usage 接口给出)。
      // 取代原来的「成功率」格子 —— 那是整期累计的运维指标, 对「今天还该不该放开用」没有决策价值。
      const periodStart = usage && usage.periodStart ? toMs(usage.periodStart) : null;
      const periodDays = periodStart !== null ? Math.max(0, (Date.now() - periodStart) / 86400000) : null;
      const dailyAvg = monthUsed !== null && periodDays !== null && periodDays > 0 ? monthUsed / periodDays : null;

      // 超额预警: 用本周期日均推算"剩余额度够不够撑到重置"。
      // 进度条只说现在用了多少; 这条只在"按这个速度会在重置前用光"时出现。
      let etaNote = null;
      if (monthCap !== null && monthUsed !== null && dailyAvg !== null && dailyAvg > 0 && monthReset) {
        const resetMs = toMs(monthReset);
        const daysLeft = resetMs === null ? null : (resetMs - Date.now()) / 86400000;
        const daysToEmpty = (monthCap - monthUsed) / dailyAvg;
        if (daysLeft !== null && daysLeft > 0.5 && daysToEmpty > 0 && daysToEmpty < daysLeft) {
          etaNote = `按当前日均，约 ${Math.max(1, Math.round(daysToEmpty))} 天后用完`;
        }
      }

      const rows = [];

      // 缓存兜底提示: 接口超时, 当前显示的是上次成功获取的数据
      if (staleList.length > 0) {
        rows.push(React.createElement("div", {
          key: "stale",
          style: {
            margin: "10px 16px 0",
            fontSize: 11,
            color: T.label3,
            lineHeight: 1.55,
          },
        }, `⏱ ${staleList.map((s) => ENDPOINT_NAMES[s.endpoint] || s.endpoint).join("、")} 本次请求超时，显示的是上次成功获取的数据（点右上角 ⟳ 重试）`));
      }

      // 余额 + 账户信息: 状态灯与「本月剩余」同排, 其余信息独占整行 ——
      // 灯放右边单独占一行会把"订阅开通"挤到换行。
      rows.push(React.createElement("div", {
        key: "balance",
        style: { padding: "14px 16px 13px" },
      },
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 } },
          React.createElement("span", { style: { fontSize: 11, color: T.label3 } }, "本月剩余"),
          // 三档状态灯: 当前档亮起, 其余压暗 —— 比单独一个 "active" 更能说明处在哪一档。
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
            STATUS_LEVELS.map((level) => {
              const active = level.key === statusLevel;
              return React.createElement("span", {
                key: level.key,
                title: level.hint,
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 10.5,
                  fontWeight: active ? 700 : 500,
                  color: active ? level.color : T.label3,
                  background: active ? `color-mix(in srgb, ${level.color} 14%, transparent)` : "transparent",
                  border: `1px solid ${active ? `color-mix(in srgb, ${level.color} 38%, transparent)` : "transparent"}`,
                  borderRadius: 99,
                  padding: "2px 6px",
                  opacity: active ? 1 : 0.5,
                  whiteSpace: "nowrap",
                },
              }, React.createElement("span", {
                style: {
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: active ? level.color : T.label3,
                  display: "inline-block",
                },
              }), level.label);
            }))),
        React.createElement("div", {
          style: {
            fontSize: 28,
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-.8px",
            fontVariantNumeric: "tabular-nums",
            color: T.label,
          },
        }, fmtCurrency(balance.monthlyCredits)),
        React.createElement("div", { style: { marginTop: 6, fontSize: 11, color: T.label3, lineHeight: 1.6, fontVariantNumeric: "tabular-nums" } },
          `总消耗 ${fmtCurrency(usage && usage.totalCost)}　Tokens ${fmtNumber(usage && usage.totalTokens)}`),
        React.createElement("div", { style: { fontSize: 11, color: T.label3, lineHeight: 1.6, fontVariantNumeric: "tabular-nums" } },
          `日均 ${fmtCurrency(dailyAvg)}` + (periodDays !== null && periodDays >= 1 ? `　本周期 ${Math.floor(periodDays)} 天` : "")),
        React.createElement("div", { style: { marginTop: 4, fontSize: 11, color: T.label3, lineHeight: 1.6 } },
          subSince
            ? `订阅开通 ${fmtDay(subSince)}，已 ${fmtElapsed(subSince)}`
            : (subFailed ? "订阅接口本次未响应（点右上角 ⟳ 重试）" : "订阅信息暂不可用"))));

      // 订阅取消续费提示
      if (subscription && subscription.cancelAtPeriodEnd === true) {
        rows.push(React.createElement("div", {
          key: "cancel",
          style: { padding: "0 16px 10px", fontSize: 11, color: T.warn, lineHeight: 1.55 },
        }, `⚠ 订阅将于 ${fmtDay(subscription.currentPeriodEnd)} 到期，不再续费`));
      }

      // 三个窗口: 三张卡, 统一放在一个网格容器里
      const windowCards = [];
      if (windowLimits && windowLimits.fiveHour) {
        windowCards.push(React.createElement(QuotaRow, {
          key: "5h",
          title: "5 小时窗口",
          used: windowLimits.fiveHour.used,
          cap: windowLimits.fiveHour.cap,
          resetAt: windowLimits.fiveHour.resetAt,
          exceeded: windowLimits.fiveHour.exceeded,
          brand: brandHex,
        }));
      }
      if (windowLimits && windowLimits.weekly) {
        windowCards.push(React.createElement(QuotaRow, {
          key: "week",
          title: "每周窗口",
          used: windowLimits.weekly.used,
          cap: windowLimits.weekly.cap,
          resetAt: windowLimits.weekly.resetAt,
          exceeded: windowLimits.weekly.exceeded,
          brand: brandHex,
        }));
      }
      if (monthCap !== null) {
        windowCards.push(React.createElement(QuotaRow, {
          key: "month",
          title: "每月窗口",
          used: monthUsed,
          cap: monthCap,
          resetAt: monthReset,
          brand: brandHex,
          note: etaNote,
        }));
      }
      if (windowCards.length > 0) {
        rows.push(React.createElement("div", {
          key: "windows",
          style: { padding: "0 12px 12px", display: "grid", gap: 9 },
        }, windowCards));
      }

      // 底部: 账户 + 更新时间
      rows.push(React.createElement("div", {
        key: "foot",
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px 14px",
          marginTop: 6,
          borderTop: `1px solid ${T.borderL}`,
          fontSize: 11.5,
          color: T.label3,
        },
      },
        React.createElement("span", null, user ? user.name : ""),
        React.createElement("span", null, data.fetchedAt ? fmtDate(data.fetchedAt) : "")));

      return React.createElement("div", null, rows);
    }

    // 配色选择: 六个颜色分两行排列, 只影响低用量起点色, 高用量仍统一走向暖色。
    function PalettePicker({ value, onChange }) {
      return React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px 9px",
          borderBottom: `1px solid ${T.borderL}`,
          fontSize: 11.5,
          color: T.label3,
        },
      },
        React.createElement("span", { style: { whiteSpace: "nowrap" } }, "进度色"),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, flex: 1 } },
          PALETTES.map((p) => {
            const on = Boolean(value) && value.key === p.key;
            return React.createElement("button", {
              key: p.key,
              type: "button",
              title: p.label,
              "aria-pressed": on,
              onClick: () => onChange(p),
              style: {
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                padding: "3px 6px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 11,
                fontFamily: "inherit",
                color: on ? T.label : T.label3,
                background: on ? T.bg2 : "transparent",
                border: `1px solid ${on ? T.hairline : "transparent"}`,
              },
            },
              React.createElement("span", {
                style: { width: 8, height: 8, borderRadius: "50%", background: p.hex, display: "inline-block", flexShrink: 0 },
              }),
              p.label);
          })));
    }

    // ---- 主组件 -------------------------------------------------------------------

    function UsageBadge() {
      const [readoutOpen, setReadoutOpen] = useState(false);
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const timerRef = useRef(null);
      // 凭据条目：与 data / error 完全解耦 —— 这样面板报「没配 key」时依然能切换
      const [creds, setCreds] = useState({ entries: [], apiKeyEnv: null, saving: false, error: null });
      // 凭据设置默认收起(见头部齿轮按钮)
      const [gearOpen, setGearOpen] = useState(false);
      // 进度色: 默认 Claude 蓝, 记住上次选择
      const [palette, setPalette] = useState(() => {
        try {
          if (typeof localStorage === "undefined") return PALETTES[0];
          const saved = localStorage.getItem(PALETTE_STORAGE_KEY);
          return PALETTES.find((p) => p.key === saved) || PALETTES[0];
        } catch {
          return PALETTES[0];
        }
      });
      // 外层容器引用：用来判断点击是否落在「状态栏 + 面板」之外
      const rootRef = useRef(null);

      // options.full=false → 只刷余额(轻量); options.silent=true → 后台轮询, 不动 loading 态
      const refresh = useCallback(async (options = {}) => {
        const wantFull = options.full !== false;
        const silent = options.silent === true;
        // Command Code 的用量/订阅接口比余额接口慢得多, 所以两段式:
        // 先只取余额让面板立刻出内容, 再拉完整数据覆盖。
        const quickUrl = FETCH_URL + "?scope=quick";

        const pull = (url) => fetch(url, { cache: "no-store" }).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        });

        if (!silent) setLoading(true);
        try {
          const quick = await pull(quickUrl);
          if (quick) {
            setData(quick);
            // 余额拿到了就清掉上次的陈旧错误; 拿不到则让面板显示具体失败原因
            if (quick.balance) setError(null);
          }
          if (wantFull) {
            const full = await pull(FETCH_URL);
            if (full) {
              setData(full);
              setError(full.ok === false && full.error ? full.error : null);
            }
          }
        } catch (reason) {
          setError(String(reason));
        } finally {
          if (!silent) setLoading(false);
        }
      }, []);

      const loadCredentials = useCallback(async () => {
        try {
          const res = await fetch(CREDENTIALS_URL, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          setCreds((prev) => ({
            ...prev,
            entries: Array.isArray(body.entries) ? body.entries : [],
            apiKeyEnv: body.apiKeyEnv ?? null,
            error: null,
          }));
        } catch (reason) {
          setCreds((prev) => ({ ...prev, error: String(reason) }));
        }
      }, []);

      const choosePalette = useCallback((next) => {
        setPalette(next);
        try {
          if (typeof localStorage !== "undefined") localStorage.setItem(PALETTE_STORAGE_KEY, next.key);
        } catch {
          /* 隐私模式 / 存储不可用, 忽略 */
        }
      }, []);

      const pickCredential = useCallback(async (name) => {
        setCreds((prev) => ({ ...prev, saving: true, error: null }));
        try {
          const res = await fetch(CREDENTIALS_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiKeyEnv: name || null }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          setCreds((prev) => ({ ...prev, apiKeyEnv: body.apiKeyEnv ?? null, saving: false }));
          await refresh(); // 换完立刻按新条目重新查一次
        } catch (reason) {
          setCreds((prev) => ({ ...prev, saving: false, error: String(reason) }));
        }
      }, [refresh]);

      useEffect(() => {
        loadCredentials();
        refresh();
        // 分层轮询: 余额 3 分钟 / 用量+订阅 30 分钟。页面不可见时整轮跳过,
        // 切回前台立刻补一次完整查询 —— 后台不白打上游接口。
        const doc = typeof document !== "undefined" ? document : null;
        const visible = () => !doc || doc.hidden !== true;
        const quickTimer = setInterval(() => { if (visible()) refresh({ full: false, silent: true }); }, QUICK_REFRESH_MS);
        const fullTimer = setInterval(() => { if (visible()) refresh({ silent: true }); }, FULL_REFRESH_MS);
        const onVisibility = () => { if (visible()) refresh({ silent: true }); };
        if (doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibility);
        timerRef.current = { quickTimer, fullTimer };
        return () => {
          clearInterval(quickTimer);
          clearInterval(fullTimer);
          if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibility);
        };
      }, [loadCredentials, refresh]);

      // 点击面板外部或按 Esc 关闭 —— 与 DSH 其它浮层的交互保持一致。
      // 之前只有再点一次徽章才关得掉, 点别处没反应。
      useEffect(() => {
        if (!readoutOpen) return undefined;
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc) return undefined;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (!root) return;
          const target = event.target;
          const inside = typeof Node !== "undefined" && target instanceof Node && root.contains(target);
          if (!inside) setReadoutOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setReadoutOpen(false);
        };
        // capture 阶段监听: 面板内元素即使 stopPropagation 也能正确判定
        doc.addEventListener("pointerdown", onPointerDown, true);
        doc.addEventListener("keydown", onKeyDown);
        return () => {
          doc.removeEventListener("pointerdown", onPointerDown, true);
          doc.removeEventListener("keydown", onKeyDown);
        };
      }, [readoutOpen]);

      function pctOf(win) {
        if (!win || typeof win.used !== "number" || typeof win.cap !== "number" || win.cap <= 0) return null;
        return Math.round((win.used / win.cap) * 100);
      }
      const mainWindows = data && data.windowLimits ? data.windowLimits : null;
      // 命名避开上面 ProjectionBody 里解构的同名 balance/usage (作用域不同, 但同名易混)
      const balView = data && data.balance ? data.balance : null;
      const usgView = data && data.usage ? data.usage : null;

      // 月度占比: 本周期已用月度积分 / (已用 + 剩余月度积分)
      const monthUsed = usgView && typeof usgView.totalMonthlyCredits === "number" ? usgView.totalMonthlyCredits : null;
      const monthRemaining = balView && typeof balView.monthlyCredits === "number" ? balView.monthlyCredits : null;
      const monthTotal = monthUsed !== null && monthRemaining !== null ? monthUsed + monthRemaining : null;

      // 读数只报占比: 5 小时 / 周 / 月 (不显示金额)
      const parts = [];
      if (mainWindows && mainWindows.fiveHour) {
        const p = pctOf(mainWindows.fiveHour);
        if (p !== null) parts.push({ key: "5h", label: "5h " + p + "%" });
      }
      if (mainWindows && mainWindows.weekly) {
        const p = pctOf(mainWindows.weekly);
        if (p !== null) parts.push({ key: "wk", label: "周 " + p + "%" });
      }
      if (monthTotal !== null && monthTotal > 0 && monthUsed !== null) {
        parts.push({ key: "mo", label: "月 " + Math.round((monthUsed / monthTotal) * 100) + "%" });
      }
      // 状态栏也要能说人话: 查询失败时别再挂着「额度查询中…」骗人。
      const readout = !data
        ? [{ key: "idle", label: "Command Code" }]
        : parts.length > 0
          ? parts
          : (Array.isArray(data.errors) && data.errors.length > 0)
            ? [{ key: "err", label: "额度查询失败" }]
            : [{ key: "wait", label: "额度查询中…" }];

      // 状态栏本体: 空心图标 + 三个占比读数。不加粗, 颜色沿用官方三级文字色。
      const badgeButton = React.createElement("button", {
        style: badgeStyle,
        title: readoutOpen ? "收起 Command Code 额度占比" : "展开 Command Code 额度占比",
        "aria-label": "Command Code 额度占比",
        "aria-expanded": readoutOpen,
        onClick: () => setReadoutOpen(!readoutOpen),
        // 官方口径: hover / 展开时才浮出灰底并提亮文字(平时透明)
        onMouseEnter: (e) => {
          e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)";
          e.currentTarget.style.color = T.label2;
        },
        onMouseLeave: (e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = T.label3;
        },
      },
        React.createElement(IconBolt),
        readout.map((p, i) => React.createElement(React.Fragment, { key: p.key },
          i > 0 ? React.createElement("span", { style: { color: T.label3, opacity: .45 } }, "·") : null,
          React.createElement("span", null, p.label))));

      const iconBtn = {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color: T.label3,
        cursor: "pointer",
        transition: "background .15s, color .15s",
      };

      const iconBtnHover = {
        background: "rgba(255,255,255,.1)",
        color: T.label,
      };

      return React.createElement("div", { style: statusBarStyle, ref: rootRef },
        badgeButton,
        readoutOpen ? React.createElement("div", { style: { ...shellStyle, ...panelPosStyle } },
          React.createElement("style", null, [
            "@keyframes ccUsagePop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}",
            "@keyframes ccUsageSpin{to{transform:rotate(360deg)}}",
          ].join("")),
          React.createElement("div", {
            style: {
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "9px 10px 9px 16px",
              borderBottom: `1px solid ${T.borderL}`,
            },
          },
            React.createElement("span", { style: { fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 } },
              // 品牌点: 去掉发光效果(原来像"正在录音"), 改成 6px 方块
              React.createElement("span", { style: { width: 6, height: 6, borderRadius: 2, background: T.brand, display: "inline-block" } }),
              "Command Code"),
            React.createElement("div", { style: { display: "flex", gap: 1 } },
              React.createElement("button", {
                style: gearOpen ? { ...iconBtn, ...iconBtnHover } : iconBtn,
                title: gearOpen ? "收起凭据设置" : "凭据设置",
                "aria-label": "凭据设置",
                "aria-expanded": gearOpen,
                onClick: () => setGearOpen(!gearOpen),
                onMouseEnter: (e) => { if (!gearOpen) Object.assign(e.currentTarget.style, iconBtnHover); },
                onMouseLeave: (e) => { if (!gearOpen) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.label3; } },
              }, React.createElement(IconGear)),
              React.createElement("button", {
                style: loading ? { ...iconBtn, opacity: 0.45, cursor: "default" } : iconBtn,
                title: loading ? "刷新中…" : "刷新",
                "aria-label": "刷新",
                "aria-busy": loading,
                disabled: loading,
                onClick: () => refresh(),
                onMouseEnter: (e) => { if (!loading) Object.assign(e.currentTarget.style, iconBtnHover); },
                onMouseLeave: (e) => { if (!loading) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.label3; } },
              }, React.createElement(IconRefresh)),
              React.createElement("button", {
                style: iconBtn,
                title: "关闭",
                "aria-label": "关闭",
                onClick: () => setReadoutOpen(false),
                onMouseEnter: (e) => Object.assign(e.currentTarget.style, iconBtnHover),
                onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.label3; },
              }, React.createElement(IconClose)))),
          // 凭据选择默认收起: 它是配置项, 不该常驻在数据面板的主视觉里
          gearOpen ? React.createElement(CredentialPicker, { state: creds, onPick: pickCredential }) : null,
          gearOpen ? React.createElement(PalettePicker, { value: palette, onChange: choosePalette }) : null,
          React.createElement(DashboardBody, { data, loading, error, palette })) : null);
    }

    // ---- apply -----------------------------------------------------------------------

    function apply(ctx) {
      // 挂在输入框下方的 composer dock (官方推荐的"有分配空间"插槽),
      // 而不是 shell.overlay 浮层 —— 这样额度是常驻状态栏, 不遮挡界面, 也不和右下角浮动球重叠。
      //
      // order 决定它在这一行里的次序: 官方 stats 药丸是 order 0, 这里用 -1 排在它前面
      // (即整行最左)。改回 50 就排到官方那组后面。
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register({
          name: "conversation.composer.dock",
          id: "dsh-commandcode-quota-dashboard",
          order: -1,
        }, UsageBadge));
    }

    return { apply, inject: ["slots"] };
  },
});
