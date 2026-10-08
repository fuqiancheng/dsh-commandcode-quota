// 模拟宿主、凭据与 API，不读取真实凭据，也不访问网络。
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const plugin = join(__dirname, "..");
const source = fs.readFileSync(join(plugin, "src/index.js"), "utf8");

// 完全隔离的 DSH_HOME：保存凭据选择会写配置，绝不能落到真实的 ~/.dsh。
const fakeHome = fs.mkdtempSync(join(tmpdir(), "dsh-quota-test-"));
fs.writeFileSync(join(fakeHome, ".credentials.yaml"), [
  "version: 1",
  "refs:",
  "  PRIMARY_TEST_KEY: fixture-primary-value",
  "  FALLBACK_TEST_KEY: fixture-fallback-value",
  "records: {}",
  "",
].join("\n"));
process.on("exit", () => { try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结论 */ } });

const responses = {
  "/alpha/billing/credits": { credits: { monthlyCredits: 70 }, windowLimits: { fiveHour: { used: 10, cap: 100 } } },
  "/alpha/usage/summary": { totalMonthlyCredits: 30, totalTokens: 100, totalCost: 5, successRate: 98 },
  "/alpha/billing/subscriptions": { data: { status: "active", currentPeriodEnd: "2026-11-01T00:00:00Z" } },
  "/alpha/whoami": { user: { name: "测试账号" } },
};
function load() {
  const requests = [];
  let reply = async (url) => ({ ok: true, status: 200, json: async () => responses[new URL(url).pathname] });
  const context = vm.createContext({
    Buffer, URL, AbortController, setTimeout, clearTimeout, createHash,
    // 源码的 import 会被剥掉，所以这里用到的 node 内置必须显式注入
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    join, dirname,
    homedir: () => fakeHome,
    process: { env: { DSH_HOME: fakeHome } },
    credentialRef: (ref) => ref,
    fetch: async (url, options) => { requests.push({ url, options }); return reply(url, options); },
  });
  vm.runInContext(source.replace(/^import .*;\r?$/gm, "").replace(/^export .*;\r?$/gm, "") +
    "\nglobalThis.host = { apply, fetchDashboard, inject, name };", context);
  return { host: context.host, requests, respond(fn) { reply = fn; } };
}
const DASHBOARD = "/__dsh-commandcode-quota/dashboard";
const CREDS = "/__dsh-commandcode-quota/credentials";

function mount(runtime, config = {}, keys = {}, lazy = false, settings = undefined) {
  const routes = new Map();
  const refs = [];
  const web = { register(row) { routes.set(row.path, row); return () => {}; } };
  const credentials = { async resolve(ref) { refs.push(ref); return { value: keys[ref] ?? "" }; } };
  const ctx = {
    get(name) {
      if (name === "credentials") return credentials;
      if (name === "settings") return settings;
      if (name === "webServer") return lazy ? undefined : web;
      return undefined;
    },
    effect(fn) { return fn(); },
    inject(names, fn) { assert.deepEqual(Array.from(names), ["webServer"]); fn({ webServer: web, effect: ctx.effect }); },
    logger: { info() {} },
  };
  runtime.host.apply(ctx, config);
  assert.equal(runtime.host.name, "dsh-commandcode-quota");
  assert.deepEqual(Array.from(runtime.host.inject), ["credentials"]);

  const dashboard = routes.get(DASHBOARD);
  assert.ok(dashboard, "必须注册 dashboard 端点");
  assert.equal(dashboard.kind, "exact");
  const creds = routes.get(CREDS);
  assert.ok(creds, "必须注册 credentials 端点");
  assert.equal(creds.kind, "exact");

  async function invoke(handler, method, url, payload) {
    let status, headers, raw;
    const listeners = {};
    const req = {
      method,
      url,
      on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return req; },
      destroy() {},
    };
    const pending = handler(req, {
      writeHead(code, values) { status = code; headers = values; },
      end(body) { raw = body; },
    });
    if (payload !== undefined) {
      for (const fn of listeners.data || []) fn(JSON.stringify(payload));
      for (const fn of listeners.end || []) fn();
    }
    await pending;
    assert.equal(headers["cache-control"], "no-store");
    assert.equal(headers["content-length"], Buffer.byteLength(raw));
    return { status, body: JSON.parse(raw), raw };
  }

  return {
    refs,
    request(url = DASHBOARD, method = "GET", payload) {
      return invoke(url.includes("/credentials") ? creds.handler : dashboard.handler, method, url, payload);
    },
  };
}
const config = { apiKeyEnv: "PRIMARY_TEST_KEY", fallbackEnv: "FALLBACK_TEST_KEY", baseURL: "https://mock.invalid" };
async function main() {
  const runtime = load();
  const app = mount(runtime, config, { PRIMARY_TEST_KEY: "fixture-primary" });
  const full = await app.request();
  assert.equal(full.status, 200);
  assert.equal(full.body.ok, true);
  assert.equal(full.body.balance.monthlyCredits, 70);
  assert.equal(full.body.usage.totalMonthlyCredits, 30);
  assert.equal(full.body.subscription.status, "active");
  assert.equal(full.body.user.name, "测试账号");
  for (const field of ["providers", "providerId", "providerLabel", "keyInfo", "warnings"]) {
    assert.ok(!(field in full.body), `单账号响应不应包含 ${field}`);
  }
  assert.ok(!full.raw.includes("fixture-primary"));
  assert.equal(runtime.requests.length, 4);
  assert.ok(runtime.requests.every(req => req.options.headers.authorization === "Bearer fixture-primary"));
  assert.deepEqual(app.refs, ["PRIMARY_TEST_KEY"]);
  runtime.requests.length = 0;
  const quick = await app.request(DASHBOARD + "?scope=quick");
  assert.equal(runtime.requests.length, 1);
  assert.equal(new URL(runtime.requests[0].url).pathname, "/alpha/billing/credits");
  assert.equal(quick.body.usage.totalMonthlyCredits, 30);
  assert.deepEqual(quick.body.cached, ["usage", "subscriptions", "whoami"]);
  runtime.respond(async () => ({ status: 503, json: async () => ({}) }));
  const stale = await app.request();
  assert.equal(stale.body.balance.monthlyCredits, 70);
  assert.equal(stale.body.stale.length, 4);
  runtime.respond(async () => ({ status: 401, json: async () => ({}) }));
  const unauthorized = await app.request();
  assert.equal(unauthorized.body.ok, false);
  assert.equal(unauthorized.body.balance, undefined);
  assert.equal(unauthorized.body.errors.length, 4);
  runtime.requests.length = 0;
  assert.equal((await app.request(undefined, "POST")).status, 405);
  assert.equal(runtime.requests.length, 0);
  const fallbackRuntime = load();
  const fallback = mount(fallbackRuntime, config, { FALLBACK_TEST_KEY: "fixture-fallback" }, true);
  assert.equal((await fallback.request(DASHBOARD + "?scope=quick")).body.keyConfigured, true);
  assert.deepEqual(fallback.refs, ["PRIMARY_TEST_KEY", "FALLBACK_TEST_KEY"]);
  assert.equal(fallbackRuntime.requests[0].options.headers.authorization, "Bearer fixture-fallback");
  const emptyRuntime = load();
  const missing = await mount(emptyRuntime, config).request();
  assert.equal(missing.body.keyConfigured, false);
  assert.equal(missing.body.ok, false);
  assert.equal(emptyRuntime.requests.length, 0);
  assert.ok(missing.body.error.includes("凭据条目"), "缺 key 的提示应指向面板里的选择器");
  // 缺 key 时，凭据端点必须照常可用 —— 这正是用户最需要它的时候
  const missingApp = mount(load(), config);
  const listedWhenEmpty = await missingApp.request(CREDS);
  assert.equal(listedWhenEmpty.status, 200, "没配 key 时凭据端点也必须可用");
  assert.equal(listedWhenEmpty.body.apiKeyEnv, "PRIMARY_TEST_KEY");
  const defaultRuntime = load();
  assert.equal((await mount(defaultRuntime, {}, { COMMANDCODE_API_KEY: "fixture-default" }).request()).body.ok, true);
  let attempts = 0;
  const retryRuntime = load();
  retryRuntime.respond(async (url) => {
    if (++attempts === 1) throw new TypeError("模拟连接失败");
    return { status: 200, json: async () => responses[new URL(url).pathname] };
  });
  assert.equal((await mount(retryRuntime, config, { PRIMARY_TEST_KEY: "fixture-primary" }).request(DASHBOARD + "?scope=quick")).body.ok, true);
  assert.equal(attempts, 2);
  const timeoutRuntime = load();
  timeoutRuntime.respond((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("模拟超时")), { once: true });
  }));
  assert.equal((await mount(timeoutRuntime, { ...config, timeoutMs: 5 }, { PRIMARY_TEST_KEY: "fixture-primary" }).request(DASHBOARD + "?scope=quick")).body.ok, false);
  assert.equal(timeoutRuntime.requests.length, 1, "主动超时不重试");

  // 凭据条目端点：GET 只回条目名 + 当前选择，POST 保存选择。放在最后跑，因为保存会改变后续读取。
  const credsApp = mount(load(), config, { PRIMARY_TEST_KEY: "fixture-primary" });
  const listed = await credsApp.request(CREDS);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.entries, [
    { ref: "PRIMARY_TEST_KEY", provider: null },
    { ref: "FALLBACK_TEST_KEY", provider: null },
  ], "一个都对不上供应商时回退显示全部，免得多拉是空的");
  assert.equal(listed.body.apiKeyEnv, "PRIMARY_TEST_KEY");
  for (const secret of ["fixture-primary-value", "fixture-fallback-value"]) {
    assert.ok(!listed.raw.includes(secret), `凭据端点绝不能回值：${secret}`);
  }
  const saved = await credsApp.request(CREDS, "POST", { apiKeyEnv: "FALLBACK_TEST_KEY" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.apiKeyEnv, "FALLBACK_TEST_KEY");
  assert.equal(
    (await credsApp.request(CREDS, "POST", { apiKeyEnv: "not a valid ref" })).status,
    400,
    "非法条目名必须被拒",
  );
  assert.equal((await credsApp.request(CREDS, "DELETE")).status, 405);
  // 保存过的选择要覆盖 profile patch 里的 apiKeyEnv
  const chosenRuntime = load();
  const chosen = mount(chosenRuntime, config, { FALLBACK_TEST_KEY: "fixture-fallback" });
  assert.equal((await chosen.request(DASHBOARD + "?scope=quick")).body.keyConfigured, true);
  assert.deepEqual(chosen.refs, ["FALLBACK_TEST_KEY"], "保存的选择应优先于 patch 配置");

  // 供应商映射：provider.apiKeyEnv 指向条目名时，下拉显示供应商名而不是裸条目名
  const settingsStub = {
    describe: () => ([{
      ns: "llm-pi-ai",
      user: {
        providers: {
          commandcode2: { apiKeyEnv: "PRIMARY_TEST_KEY" },
          cerebras: { displayName: "bailian", apiKeyEnv: "FALLBACK_TEST_KEY" },
          noKey: { baseURL: "https://example.invalid" },
        },
      },
    }]),
  };
  const labeled = await mount(load(), config, { PRIMARY_TEST_KEY: "x" }, false, settingsStub).request(CREDS);
  assert.deepEqual(labeled.body.entries, [
    { ref: "PRIMARY_TEST_KEY", provider: "commandcode2" },
    { ref: "FALLBACK_TEST_KEY", provider: "bailian" },
  ], "应把条目名翻译成模型设置里显示的供应商名");
  // describe() 抛错时必须降级，而不是让整个端点失败
  const broken = await mount(load(), config, {}, false, { describe() { throw new Error("boom"); } }).request(CREDS);
  assert.equal(broken.status, 200, "settings 读不到时应降级而不是报错");
  assert.deepEqual(broken.body.entries.map((e) => e.provider), [null, null]);
  // 只有部分条目对得上时，只列出对得上的 —— 对不上的说明用户没在用它
  const partial = await mount(load(), config, {}, false, {
    describe: () => ([{
      ns: "llm-pi-ai",
      user: { providers: { cerebras: { displayName: "bailian", apiKeyEnv: "FALLBACK_TEST_KEY" } } },
    }]),
  }).request(CREDS);
  assert.deepEqual(partial.body.entries, [
    { ref: "FALLBACK_TEST_KEY", provider: "bailian" },
  ], "只应列出对得上模型供应商的条目");

  // 包自检：声明、注册 id 与 bundle 补丁层三者必须一致。
  const manifest = JSON.parse(fs.readFileSync(join(plugin, "package.json"), "utf8"));
  assert.equal(manifest.name, "dsh-commandcode-quota", "package.json 的 name 必须等于宿主端导出 name");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml", "必须声明 bundle 补丁层");
  const patch = fs.readFileSync(join(plugin, "cordis.patch.yml"), "utf8");
  assert.ok(
    patch.includes(`id: ${manifest.name}`) && patch.includes(`name: '${manifest.name}'`),
    "bundle 补丁的注册 id 与包名必须一致",
  );
  // 发版时最容易漏的一处：user-agent 里的版本号要与 package.json 同步。
  const uaVersion = source.match(/"user-agent":\s*"[^"]*\/([^"]+)"/)?.[1];
  assert.equal(uaVersion, manifest.version, "user-agent 版本必须与 package.json 的 version 一致");
  console.log("通过：单账号响应、主/回退凭据、完整/快速查询、缓存、401、405、重试和超时。");
  console.log("通过：凭据端点只回条目名、翻译供应商名、保存后覆盖 patch 配置、非法名被拒、无 key 时依然可用。");
  console.log("通过：宿主端导出、路由、包名与 bundle 补丁层一致。");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
