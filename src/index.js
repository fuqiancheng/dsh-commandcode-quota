/**
 * dsh-commandcode-quota —— Command Code 余额额度仪表盘（单账号宿主端）
 *
 * 通过 Command Code 官方 API 读取余额与限额数据, 在 DSH Web 界面提供
 * 一个与 OpenCode 余额查询类似的单账号仪表盘。
 *
 *   GET /__dsh-commandcode-quota/dashboard              → 余额 + 限额 + 用量
 *   GET /__dsh-commandcode-quota/dashboard?scope=quick  → 余额优先，其余字段用缓存回填
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
        "user-agent": "dsh-commandcode-quota/0.2.0"
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

// --- plugin ------------------------------------------------------------------

function apply(ctx, config) {
  const account = normalizeAccount(config);
  const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;

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

          const options = await resolveAccountOptions(ctx, account);
          const meta = { ok: true };
          if (options.apiKey.length === 0) {
            sendJson(res, 200, {
              ...meta,
              ok: false,
              error: `未配置 API key (尝试过: ${options.triedEnvs.join(", ") || "无"}); 请在 ~/.dsh/.credentials.yaml 中配置`,
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
