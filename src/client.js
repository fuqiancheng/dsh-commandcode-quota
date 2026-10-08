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
    // 每 3 分钟后台自动刷新一次余额(面板开/关都刷新, 打开时看到的就是最新数据)
    const REFRESH_MS = 3 * 60 * 1000;

    // ---- 格式化 --------------------------------------------------------------

    function fmtCurrency(value, digits = 2) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return "$" + value.toFixed(digits);
    }

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
      return `${m}分${Math.floor((diff % 60000) / 1000)}秒`;
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
      bg2: "var(--dsw-alias-bg-layer-2, #2c2c2e)",
      bg3: "var(--dsw-alias-bg-layer-3, #353636)",
      border: "var(--dsw-alias-border-l2, rgba(255,255,255,.14))",
      borderL: "var(--dsw-alias-border-l1, rgba(255,255,255,.08))",
      label: "var(--dsw-alias-label-primary, #f9fafb)",
      label2: "var(--dsw-alias-label-secondary, #d3d5d9)",
      label3: "var(--dsw-alias-label-tertiary, #adb2b8)",
      // 进度条轨道在 深色主题下直接用近黑半透明 (Bar 里用 TRACK_STYLE 常量)
      track: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.2))",
      success: "var(--dsw-alias-state-success-primary, #22c55e)",
      warn: "var(--dsw-alias-state-warn-primary, #f59e0b)",
      error: "var(--dsw-alias-state-error-primary, #f25a5a)",
      brand: "var(--dsw-alias-brand-primary, #679efe)",
    };

    // 深色主题下进度条轨道: 近黑半透明, 与填充色形成强对比
    const TRACK_STYLE = "rgba(0, 0, 0, 0.35)";

    // ---- 样式常量 -------------------------------------------------------------

    // 面板: 由 shellStyle 的绝对定位容器承载, 从状态栏上方展开(不再是右下角浮层)
    const shellStyle = {
      width: 352,
      maxWidth: "calc(100vw - 40px)",
      maxHeight: "calc(100vh - 120px)",
      overflowY: "auto",
      pointerEvents: "auto",
      zIndex: 9999,
      fontFamily: "inherit",
      color: T.label,
      borderRadius: 16,
      background: T.bg,
      border: `1px solid ${T.border}`,
      boxShadow: "0 16px 56px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.35)",
      overflow: "hidden",
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

    // 进度条: 轨道用深色 (与卡片背景强对比), 填充用 color-mix 渐变色
    function Bar({ pct, color }) {
      const clamped = Math.max(0, Math.min(100, pct || 0));
      const fillColor = color || T.success;
      return React.createElement("div", {
        style: {
          height: 10,
          borderRadius: 99,
          background: TRACK_STYLE,
          border: "1px solid rgba(255,255,255,.06)",
          overflow: "hidden",
          padding: 1,
        },
      },
        React.createElement("div", {
          style: {
            width: clamped + "%",
            height: "100%",
            borderRadius: 99,
            background: `linear-gradient(90deg, ${fillColor}, color-mix(in srgb, ${fillColor} 78%, #ffffff 22%))`,
            boxShadow: `0 0 10px color-mix(in srgb, ${fillColor} 45%, transparent)`,
            transition: "width .5s cubic-bezier(.3,.8,.3,1)",
          },
        }));
    }

    // 限额卡片: 标题 + 百分比 + 进度条 + 已用/上限/剩余 + 重置时间
    function LimitCard({ title, used, cap, resetAt }) {
      const capSafe = cap > 0 ? cap : (used > 0 ? used : 1);
      const pct = capSafe > 0 ? Math.min(100, (used / capSafe) * 100) : 0;
      const color = pct >= 90 ? T.error : pct >= 70 ? T.warn : T.success;
      const remaining = Math.max(0, capSafe - used);
      return React.createElement("div", {
        style: {
          background: T.bg2,
          border: `1px solid ${T.borderL}`,
          borderRadius: 12,
          padding: "12px 14px",
        },
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 } },
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, color: T.label } },
            React.createElement(IconClock, { color }),
            title),
          React.createElement("span", { style: { fontSize: 16, fontWeight: 800, fontVariantNumeric: "tabular-nums", color } },
            (Math.round(pct * 10) / 10) + "%")),
        React.createElement(Bar, { pct, color }),
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 9, fontSize: 11.5, color: T.label2, fontVariantNumeric: "tabular-nums" } },
          React.createElement("span", null, `已用 ${fmtCurrency(used)}`),
          React.createElement("span", null, `上限 ${fmtCurrency(capSafe)}`)),
        React.createElement("div", { style: { marginTop: 3, fontSize: 11, color: T.label3 } },
          `剩余 ${fmtCurrency(remaining)} · 重置 ${fmtDuration(resetAt)}${fmtResetDay(resetAt)}`));
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
          padding: "9px 16px",
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
            padding: "4px 6px",
            fontSize: 11.5,
            fontFamily: "inherit",
            color: T.label2,
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            cursor: safe.saving ? "default" : "pointer",
          },
        },
          React.createElement("option", { value: "" }, "（未设置）"),
          options.map((e) => React.createElement("option", { key: e.ref, value: e.ref }, labelOf(e)))),
        safe.saving ? React.createElement("span", null, "…") : null,
        safe.error ? React.createElement("span", { style: { color: T.error } }, safe.error) : null);
    }

    // ---- 面板内容 ----------------------------------------------------------------

    function DashboardBody({ data, loading, error }) {
      if (error) {
        return React.createElement("div", { style: { padding: "16px 16px 20px" } },
          React.createElement("div", {
            style: {
              background: "color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 14%, transparent)",
              border: "1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 38%, transparent)",
              borderRadius: 12,
              padding: "12px 14px",
              fontSize: 12.5,
              color: T.error,
              lineHeight: 1.5,
            },
          }, String(error)));
      }
      if (loading && !data) {
        return React.createElement("div", { style: { padding: "24px 16px", textAlign: "center", fontSize: 12.5, color: T.label3 } },
          React.createElement("div", { style: { width: 22, height: 22, margin: "0 auto 10px", border: "2px solid rgba(255,255,255,.18)", borderTopColor: T.brand, borderRadius: "50%", animation: "ccUsageSpin .8s linear infinite" } }),
          "正在获取余额…（Command Code 接口较慢，约需 10~20 秒）");
      }
      if (!data || !data.balance) return null;

      const { balance, windowLimits, usage, subscription, user } = data;

      // 订阅开通时间: 优先 createdAt, 回退到当前周期开始
      const subSince = subscription && (subscription.createdAt || subscription.currentPeriodStart) || null;

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

      const rows = [];

      // 数据一致性告警 (典型: 两个账号解析到同一个 API key, 余额自然相同)
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      if (warnings.length > 0) {
        rows.push(React.createElement("div", {
          key: "warnings",
          style: {
            margin: "12px 16px 0",
            padding: "10px 12px",
            borderRadius: 10,
            background: "color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 15%, transparent)",
            border: "1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 45%, transparent)",
            color: T.warn,
            fontSize: 11.5,
            lineHeight: 1.55,
          },
        },
          React.createElement("div", { style: { fontWeight: 700, marginBottom: 4 } }, "⚠ 凭据告警"),
          warnings.map((w, i) => React.createElement("div", { key: i, style: { marginTop: i > 0 ? 4 : 0 } }, w))));
      }

      // 缓存兜底提示: 接口超时, 当前显示的是上次成功获取的数据
      if (staleList.length > 0) {
        const FIELD_NAMES = { credits: "余额", usage: "用量", subscriptions: "订阅", whoami: "账户" };
        rows.push(React.createElement("div", {
          key: "stale",
          style: {
            margin: "10px 16px 0",
            fontSize: 11,
            color: T.label3,
            lineHeight: 1.55,
          },
        }, `⏱ ${staleList.map((s) => FIELD_NAMES[s.endpoint] || s.endpoint).join("、")} 本次请求超时，显示的是上次成功获取的数据（点右上角 ⟳ 重试）`));
      }

      // Hero: 余额大数字
      rows.push(React.createElement("div", {
        key: "hero",
        style: {
          padding: "18px 16px 16px",
          background: `linear-gradient(150deg, ${T.bg3}, ${T.bg2})`,
          borderBottom: `1px solid ${T.borderL}`,
        },
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
          React.createElement("div", null,
            React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: T.label3, letterSpacing: ".7px", textTransform: "uppercase", marginBottom: 4 } }, "可用余额 Balance"),
            React.createElement("div", {
              style: {
                fontSize: 34,
                fontWeight: 800,
                lineHeight: 1.05,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-1px",
                color: T.label,
              },
            }, fmtCurrency(balance.monthlyCredits))),
          React.createElement("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 15%, transparent)",
              border: "1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 40%, transparent)",
              color: T.success,
              borderRadius: 99,
              padding: "4px 11px",
              fontSize: 11.5,
              fontWeight: 600,
            },
          },
            React.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", background: T.success, display: "inline-block" } }),
            (subscription && subscription.status) ? subscription.status : "active")),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 11.5, color: T.label2 } },
            React.createElement(IconCalendar, { color: T.brand }),
            React.createElement("span", null, subSince
              ? `开通于 ${fmtDay(subSince)} · 已使用 ${fmtElapsed(subSince)}`
              : (subFailed ? "订阅接口本次未响应（点右上角 ⟳ 重试）" : "订阅信息暂不可用"))),
        React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 12 } },
          React.createElement(StatCard, { label: "总消耗", value: fmtCurrency(usage && usage.totalCost) }),
          React.createElement(StatCard, { label: "Tokens", value: fmtNumber(usage && usage.totalTokens) }),
          React.createElement(StatCard, { label: "成功率", value: usage ? usage.successRate + "%" : "—" }))));

      // 限额卡片: 5小时 / 每周 / 每月
      const limitCards = [];
      if (windowLimits && windowLimits.fiveHour) {
        limitCards.push(React.createElement(LimitCard, {
          key: "5h",
          title: "5 小时窗口",
          used: windowLimits.fiveHour.used,
          cap: windowLimits.fiveHour.cap,
          resetAt: windowLimits.fiveHour.resetAt,
        }));
      }
      if (windowLimits && windowLimits.weekly) {
        limitCards.push(React.createElement(LimitCard, {
          key: "week",
          title: "每周窗口",
          used: windowLimits.weekly.used,
          cap: windowLimits.weekly.cap,
          resetAt: windowLimits.weekly.resetAt,
        }));
      }
      if (monthCap !== null) {
        limitCards.push(React.createElement(LimitCard, {
          key: "month",
          title: "每月窗口",
          used: monthUsed,
          cap: monthCap,
          resetAt: monthReset,
        }));
      }
      if (limitCards.length > 0) {
        rows.push(React.createElement("div", { key: "limits", style: { padding: "14px 16px 4px" } },
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: T.label3, letterSpacing: ".7px", textTransform: "uppercase", marginBottom: 10 } },
            "窗口限额 Usage Limits"),
          React.createElement("div", { style: { display: "grid", gap: 10 } }, limitCards)));
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

    // ---- 主组件 -------------------------------------------------------------------

    function UsageBadge() {
      const [readoutOpen, setReadoutOpen] = useState(false);
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const timerRef = useRef(null);
      // 凭据条目：与 data / error 完全解耦 —— 这样面板报「没配 key」时依然能切换
      const [creds, setCreds] = useState({ entries: [], apiKeyEnv: null, saving: false, error: null });

      const refresh = useCallback(async () => {
        const fullUrl = FETCH_URL;
        // Command Code 的用量/订阅接口要 10~25 秒, 余额接口 1~5 秒。
        // 先只取余额(带上次缓存的用量/订阅)让面板立刻出内容, 再拉完整数据覆盖。
        const quickUrl = fullUrl + "?scope=quick";

        const pull = (url) => fetch(url, { cache: "no-store" }).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        });

        setLoading(true);
        try {
          const quick = await pull(quickUrl);
          if (quick) {
            setData(quick);
          }
          const full = await pull(fullUrl);
          if (full) {
            setData(full);
            setError(full.ok === false && full.error ? full.error : null);
          }
        } catch (reason) {
          setError(String(reason));
        } finally {
          setLoading(false);
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
        // 每 3 分钟自动查询一次余额(面板打开时也刷新)
        timerRef.current = setInterval(() => refresh(), REFRESH_MS);
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
      }, [loadCredentials, refresh]);

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
      const readout = data
        ? (parts.length > 0 ? parts : [{ key: "wait", label: "额度查询中…" }])
        : [{ key: "idle", label: "Command Code" }];

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

      return React.createElement("div", { style: statusBarStyle },
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
              padding: "10px 10px 10px 16px",
              borderBottom: `1px solid ${T.borderL}`,
            },
          },
            React.createElement("span", { style: { fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 } },
              React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: T.brand, boxShadow: `0 0 8px ${T.brand}` } }),
              "Command Code"),
            React.createElement("div", { style: { display: "flex", gap: 2 } },
              React.createElement("button", {
                style: iconBtn,
                title: "刷新",
                "aria-label": "刷新",
                disabled: loading,
                onClick: refresh,
                onMouseEnter: (e) => Object.assign(e.currentTarget.style, iconBtnHover),
                onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.label3; },
              }, React.createElement(IconRefresh)),
              React.createElement("button", {
                style: iconBtn,
                title: "关闭",
                "aria-label": "关闭",
                onClick: () => setReadoutOpen(false),
                onMouseEnter: (e) => Object.assign(e.currentTarget.style, iconBtnHover),
                onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.label3; },
              }, React.createElement(IconClose)))),
          React.createElement(CredentialPicker, { state: creds, onPick: pickCredential }),
          React.createElement(DashboardBody, { data, loading, error })) : null);
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
