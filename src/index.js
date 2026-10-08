/**
 * dsh-commandcode-quota —— Command Code 余额额度仪表盘（单账号宿主端）
 *
 * 通过 Command Code 官方 API 读取余额与限额数据, 在 DSH Web 界面提供
 * 一个与 OpenCode 余额查询类似的单账号仪表盘。
 *
 *   GET  /__dsh-commandcode-quota/dashboard              → 余额 + 限额 + 用量
 *   GET  /__dsh-commandcode-quota/dashboard?scope=quick  → 余额优先，其余字段用缓存回填
 *   GET  /__dsh-commandcode-quota/credentials            → 候选凭据条目名 + 当前选择
 *   POST /__dsh-commandcode-quota/credentials            → 保存选择的凭据条目名
 *
 * 数据源 (均为 Authorization: Bearer <key> 的 GET 请求):
 *   GET {base}/alpha/billing/credits        余额 & 窗口限额
 *   GET {base}/alpha/usage/summary          用量汇总
 *   GET {base}/alpha/billing/subscriptions  订阅信息
 *   GET {base}/alpha/whoami                 用户信息
 *
 * 凭据通过 ctx.credentials 服务解析，不向客户端返回 API key。
 *
 * 配置 (cordis.patch.yml):
 *   apiKeyEnv: COMMANDCODE_API_KEY
 *   fallbackEnv: COMMANDCODE2_API_KEY      # 可选回退凭据
 *   baseURL: https://api.commandcode.ai
 *
 * ESM module format (cordis bundle rule): named exports apply/inject/name.
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const name = "dsh-commandcode-quota";
const inject = ["credentials"];

const DEFAULT_BASE_URL = "https://api.commandcode.ai";
const DEFAULT_API_KEY_ENV = "COMMANDCODE_API_KEY";
// Command Code 的 usage / subscriptions / whoami 实测要 8~20s, 8s 超时必然误杀。
const DEFAULT_TIMEOUT_MS = 30000;

// --- HTTP helpers ------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function readQuery(req, key) {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    return url.searchParams.get(key);
  } catch {
    return null;
  }
}

// --- Command Code API client -------------------------------------------------

async function ccFetch(baseURL, path, apiKey, timeoutMs) {
  const url = `${baseURL}${path}`;
  const controller = new AbortController();
  let timedOut = false;
  const started = Date.now();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "user-agent": "dsh-commandcode-quota/0.2.1"
      },
      signal: controller.signal
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, json, tookMs: Date.now() - started };
  } catch (error) {
    const detail = timedOut
      ? `本插件超时 ${timeoutMs}ms (${Date.now() - started}ms)`
      : `${error?.name ?? "Error"}: ${error?.message ?? String(error)} (${Date.now() - started}ms)`;
    const wrapped = new Error(detail);
    wrapped.cause = error;
    wrapped.timedOut = timedOut;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

/** 连接级偶发失败 (TypeError: fetch failed / socket reset) 重试一次;
 * 本插件主动超时不重试 —— 服务器本来就慢, 再等一轮更慢。 */
async function ccFetchRetry(baseURL, path, apiKey, timeoutMs) {
  try {
    return await ccFetch(baseURL, path, apiKey, timeoutMs);
  } catch (error) {
    if (error?.timedOut) throw error;
    return await ccFetch(baseURL, path, apiKey, timeoutMs);
  }
}

/**
 * 各接口的写入 / 快照 / 回填: 便于统一处理"成功则写 + 缓存, 失败则回退上次值"。
 */
const ENDPOINTS = [
  ["credits", "/alpha/billing/credits"],
  ["usage", "/alpha/usage/summary"],
  ["subscriptions", "/alpha/billing/subscriptions"],
  ["whoami", "/alpha/whoami"]
];

const HANDLERS = {
  credits: {
    apply(json, out) { out.balance = json.credits; out.windowLimits = json.windowLimits; },
    snapshot(out) { return out.balance ? { balance: out.balance, windowLimits: out.windowLimits } : null; },
    restore(snap, out) { out.balance = snap.balance; out.windowLimits = snap.windowLimits; }
  },
  usage: {
    apply(json, out) { out.usage = json; },
    snapshot(out) { return out.usage ?? null; },
    restore(snap, out) { out.usage = snap; }
  },
  subscriptions: {
    apply(json, out) { if (json.data) out.subscription = json.data; },
    snapshot(out) { return out.subscription ?? null; },
    restore(snap, out) { out.subscription = snap; }
  },
  whoami: {
    apply(json, out) { if (json.user) out.user = json.user; },
    snapshot(out) { return out.user ?? null; },
    restore(snap, out) { out.user = snap; }
  }
};

/**
 * 上次成功值的进程内缓存。
 * Command Code 的 usage / subscriptions / whoami 实测响应 8~20s 且偶发 500,
 * 超时或报错时用上次成功值兜底, 避免面板闪出"订阅信息暂不可用"。
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const lastGood = new Map();

function cacheGet(key) {
  const hit = lastGood.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit;
}

function cacheSet(key, value) {
  if (value === undefined || value === null) return;
  lastGood.set(key, { value, at: Date.now() });
}

/**
 * 请求一个账号的完整仪表盘数据。
 * 四个接口并行发出 (总耗时 = 最慢的一个, 而不是四个之和), 单接口失败不影响其他;
 * 失败且曾有成功值时用缓存兜底, 并在 stale 里说明。
 * onlyKeys 非空时只查这些接口 (scope=quick: 只查快的 credits),
 * 其余字段用上次缓存回填, 并在 cached 里列出。
 */
async function fetchDashboard(cfg, timeoutMs, onlyKeys) {
  const errors = [];
  const stale = [];
  const out = { ok: true, fetchedAt: Date.now(), errors, stale };

  const list = Array.isArray(onlyKeys) && onlyKeys.length > 0
    ? ENDPOINTS.filter(([key]) => onlyKeys.includes(key))
    : ENDPOINTS;

  const results = await Promise.all(list.map(async ([key, path]) => {
    try {
      const res = await ccFetchRetry(cfg.baseURL, path, cfg.apiKey, timeoutMs);
      return { key, status: res.status, json: res.json };
    } catch (error) {
      return { key, error: String(error) };
    }
  }));

  for (const r of results) {
    const handler = HANDLERS[r.key];
    if (!r.error && r.status === 200 && r.json) {
      handler.apply(r.json, out);
      cacheSet(r.key, handler.snapshot(out));
      continue;
    }
    const message = r.error
      ? `请求失败: ${r.error}`
      : (r.status === 401 ? "API key 无效或无权限 (HTTP 401)" : `HTTP ${r.status}`);
    // 401 是凭据问题, 不能拿旧数据掩盖; 其余失败回退上次成功值。
    const hit = r.status === 401 ? null : cacheGet(r.key);
    if (hit) {
      handler.restore(hit.value, out);
      stale.push({ endpoint: r.key, message, at: hit.at });
    } else {
      errors.push({ endpoint: r.key, message });
    }
  }

  // quick 模式跳过的接口: 用缓存回填 (不算 stale, 本次根本没查)
  const skipped = ENDPOINTS.filter(([key]) => !list.some(([k]) => k === key));
  if (skipped.length > 0) {
    out.cached = [];
    for (const [key] of skipped) {
      const hit = cacheGet(key);
      if (!hit) continue;
      HANDLERS[key].restore(hit.value, out);
      out.cached.push(key);
    }
  }

  if (errors.length >= list.length) out.ok = false;
  return out;
}

// --- 配置解析 ------------------------------------------------------------------

/** 单账号配置；fallbackEnv 仅在首选凭据缺失时使用，不做账号切换。 */
function normalizeAccount(config) {
  return {
    apiKeyEnv: typeof config?.apiKeyEnv === "string" && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : DEFAULT_API_KEY_ENV,
    fallbackEnv: typeof config?.fallbackEnv === "string" && config.fallbackEnv.length > 0 ? config.fallbackEnv : null,
    baseURL: typeof config?.baseURL === "string" && config.baseURL.length > 0 ? config.baseURL : DEFAULT_BASE_URL
  };
}

/** 解析单账号请求选项；每次现读凭据，缺失时尝试回退条目。 */
async function resolveAccountOptions(ctx, account) {
  const credentials = ctx.get("credentials");
  const tried = [];
  const candidates = [account.apiKeyEnv, account.fallbackEnv].filter((v) => typeof v === "string" && v.length > 0);
  let apiKey = "";

  for (const envName of candidates) {
    tried.push(envName);
    if (!credentials) break;
    try {
      const resolved = await credentials.resolve(credentialRef(envName));
      if (resolved && typeof resolved.value === "string" && resolved.value.length > 0) {
        apiKey = resolved.value;
        break;
      }
    } catch { /* 试下一个 */ }
  }

  return {
    apiKey,
    triedEnvs: tried,
    baseURL: account.baseURL
  };
}

// --- 凭据条目选择（面板里可切换）----------------------------------------------
//
// 两个约束决定了这里的写法：
//   1. ctx.credentials 只有 resolve/describe/set/unset，没有「列出条目」的能力，
//      所以候选列表只能自己从 .credentials.yaml 里取 —— 且【只取键名，绝不读值】。
//   2. 选择要持久化才能跨重启生效；写进 $DSH_HOME 下的一个小 JSON，优先级高于
//      profile patch 里的 apiKeyEnv（面板里的选择是最新意图）。

/** 合法凭据条目名：POSIX shell 标识符，与 dsh-credentials 的 REF_PATTERN 一致。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}

function choiceFile() {
  return join(dshHome(), "dsh-commandcode-quota.json");
}

/** 面板里保存过的选择；没有或损坏时返回全 null（回落到 patch 配置）。 */
function readChoice() {
  try {
    const parsed = JSON.parse(readFileSync(choiceFile(), "utf8"));
    const pick = (v) => (typeof v === "string" && REF_PATTERN.test(v) ? v : null);
    return { apiKeyEnv: pick(parsed?.apiKeyEnv), fallbackEnv: pick(parsed?.fallbackEnv) };
  } catch {
    return { apiKeyEnv: null, fallbackEnv: null };
  }
}

function writeChoice(choice) {
  const file = choiceFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(choice, null, 2) + "\n", "utf8");
}

/**
 * 列出 .credentials.yaml 里 refs: 段下的条目名。
 * 只解析键、跳过一切值 —— 返回的是名字，不是密钥。
 */
function readCredentialEntries() {
  let text;
  try {
    text = readFileSync(join(dshHome(), ".credentials.yaml"), "utf8");
  } catch {
    return [];
  }
  const names = [];
  let inRefs = false;
  let indent = -1;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    if (line.trim().length === 0) continue;
    const m = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):/);
    if (!m) {
      if (/^\S/.test(line)) break; // 回到顶层键，refs 段结束
      continue;
    }
    if (indent < 0) indent = m[1].length;
    if (m[1].length === indent) names.push(m[2]);
  }
  return names;
}

/** 读取请求体（上限 8KB，够放两个条目名）。 */
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("请求体过大"));
        req.destroy?.();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// --- plugin ------------------------------------------------------------------

/**
 * 挑出要展示的凭据条目。
 *
 * 口径：对不上模型供应商的条目说明没在用它，不必占位置。
 * 但如果一个都对不上（凭据库还没和任何 provider 关联），就退回全部 ——
 * 否则下拉是空的，反而没法选。
 */
function pickEntries(refs, labels) {
  const all = refs.map((ref) => ({ ref, provider: labels[ref] ?? null }));
  const matched = all.filter((entry) => entry.provider);
  return matched.length > 0 ? matched : all;
}

/**
 * 凭据条目名 → 模型供应商显示名。
 *
 * 这层对应本来就存在于模型配置里（provider.apiKeyEnv 指向条目名），所以读
 * llm-pi-ai 的 providers 就能把 "COMMANDCODE2_API_KEY" 翻译成用户在模型设置页
 * 看到的 "commandcode2"。读不到就返回空表，调用方回落到只显示条目名。
 *
 * 用 ctx.get("settings") 而不是 inject —— 读不到时降级即可，
 * 不必因为缺少这个服务就让整个插件不激活。
 */
function readProviderLabels(ctx) {
  // 只能用 ctx.get：cordis 里访问未注入的服务属性（ctx.settings）会直接抛异常，
  // 而这里的原则是「读不到就降级」，不该让整个端点跟着失败。
  if (typeof ctx.get !== "function") return {};
  let service;
  try {
    service = ctx.get("settings");
  } catch {
    return {};
  }
  if (typeof service?.describe !== "function") return {};
  let rows;
  try {
    rows = service.describe();
  } catch {
    return {};
  }
  const row = (Array.isArray(rows) ? rows : []).find((r) => r?.ns === "llm-pi-ai");
  const providers = row?.user?.providers;
  if (!providers || typeof providers !== "object") return {};
  const labels = {};
  for (const [id, cfg] of Object.entries(providers)) {
    const ref = cfg?.apiKeyEnv;
    if (typeof ref !== "string" || ref.length === 0) continue;
    const label = typeof cfg?.displayName === "string" && cfg.displayName.length > 0 ? cfg.displayName : id;
    if (!(ref in labels)) labels[ref] = label;
  }
  return labels;
}

function apply(ctx, config) {
  const base = normalizeAccount(config);
  const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  // 每次请求重新算：面板里刚改过选择就立刻生效，不必重载插件。
  function currentAccount() {
    const saved = readChoice();
    return {
      ...base,
      apiKeyEnv: saved.apiKeyEnv ?? base.apiKeyEnv,
      fallbackEnv: saved.fallbackEnv ?? base.fallbackEnv
    };
  }

  function registerHttp(host, targetCtx) {
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/__dsh-commandcode-quota/dashboard",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        try {
          const t0 = Date.now();
          // scope=quick: 只查响应快的 credits, 用量/订阅用缓存回填 (客户端先渲染再补全)
          const scope = readQuery(req, "scope");

          const options = await resolveAccountOptions(ctx, currentAccount());
          const meta = { ok: true };
          if (options.apiKey.length === 0) {
            sendJson(res, 200, {
              ...meta,
              ok: false,
              error: `未配置 API key (尝试过: ${options.triedEnvs.join(", ") || "无"})。用面板上方的「凭据条目」选一个已有条目，或在 DSH 设置 → 凭据里添加`,
              keyConfigured: false
            });
            return;
          }
          const dashboard = await fetchDashboard(
            options,
            timeoutMs,
            scope === "quick" ? ["credits"] : null
          );
          sendJson(res, 200, { ...meta, ...dashboard, keyConfigured: true, debug: { timeoutMs, scope: scope ?? "full", handlerMs: Date.now() - t0 } });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: `仪表盘请求失败: ${String(error)}` });
        }
      }
    }));

    // 凭据条目：GET 列出候选 + 当前选择；POST 保存选择。
    // 无论如何都可用 —— 面板没配 key 时正是最需要它的时候。
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/__dsh-commandcode-quota/credentials",
      handler: async (req, res) => {
        if (req.method === "GET") {
          const account = currentAccount();
          const labels = readProviderLabels(ctx);
          sendJson(res, 200, {
            ok: true,
            // 只列能对上模型供应商的条目（口径见 pickEntries）
            entries: pickEntries(readCredentialEntries(), labels),
            apiKeyEnv: account.apiKeyEnv,
            fallbackEnv: account.fallbackEnv,
            chosen: readChoice()
          });
          return;
        }
        if (req.method === "POST") {
          try {
            const parsed = JSON.parse((await readBody(req)) || "{}");
            const next = { apiKeyEnv: null, fallbackEnv: null };
            for (const key of ["apiKeyEnv", "fallbackEnv"]) {
              const value = parsed?.[key];
              if (value === null || value === undefined || value === "") continue;
              if (typeof value !== "string" || !REF_PATTERN.test(value)) {
                sendJson(res, 400, { ok: false, error: `凭据条目名不合法: ${JSON.stringify(value)}` });
                return;
              }
              next[key] = value;
            }
            writeChoice(next);
            sendJson(res, 200, { ok: true, ...next });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: `保存失败: ${String(error)}` });
          }
          return;
        }
        sendJson(res, 405, { error: "method not allowed" });
      }
    }));
  }

  const ws = ctx.get("webServer");
  if (ws !== undefined) {
    registerHttp(ws, ctx);
  } else {
    ctx.inject(["webServer"], (sub) => {
      registerHttp(sub.webServer, sub);
    });
  }

  ctx.logger.info("[dsh-commandcode-quota] Command Code 单账号余额仪表盘已注册");
}

export { apply, fetchDashboard, inject, name };
export default { apply, inject, name };
