// 模拟宿主、凭据与 API，不读取真实凭据，也不访问网络。
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const plugin = join(__dirname, "..");
const source = fs.readFileSync(join(plugin, "src/index.js"), "utf8");
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
    credentialRef: (ref) => ref,
    fetch: async (url, options) => { requests.push({ url, options }); return reply(url, options); },
  });
  vm.runInContext(source.replace(/^import .*;\r?$/gm, "").replace(/^export .*;\r?$/gm, "") +
    "\nglobalThis.host = { apply, fetchDashboard, inject, name };", context);
  return { host: context.host, requests, respond(fn) { reply = fn; } };
}
function mount(runtime, config = {}, keys = {}, lazy = false) {
  let route;
  const refs = [];
  const web = { register(row) { route = row; return () => {}; } };
  const credentials = { async resolve(ref) { refs.push(ref); return { value: keys[ref] ?? "" }; } };
  const ctx = {
    get(name) { return name === "credentials" ? credentials : name === "webServer" && !lazy ? web : undefined; },
    effect(fn) { return fn(); },
    inject(names, fn) { assert.deepEqual(Array.from(names), ["webServer"]); fn({ webServer: web, effect: ctx.effect }); },
    logger: { info() {} },
  };
  runtime.host.apply(ctx, config);
  assert.equal(runtime.host.name, "dsh-commandcode-quota");
  assert.deepEqual(Array.from(runtime.host.inject), ["credentials"]);
  assert.equal(route.kind, "exact");
  assert.equal(route.path, "/__dsh-commandcode-quota/dashboard");
  return {
    refs,
    async request(url = route.path, method = "GET") {
      let status, headers, raw;
      await route.handler({ method, url }, {
        writeHead(code, values) { status = code; headers = values; },
        end(body) { raw = body; },
      });
      assert.equal(headers["cache-control"], "no-store");
      assert.equal(headers["content-length"], Buffer.byteLength(raw));
      return { status, body: JSON.parse(raw), raw };
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
  const quick = await app.request("/__dsh-commandcode-quota/dashboard?scope=quick");
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
  assert.equal((await fallback.request("/__dsh-commandcode-quota/dashboard?scope=quick")).body.keyConfigured, true);
  assert.deepEqual(fallback.refs, ["PRIMARY_TEST_KEY", "FALLBACK_TEST_KEY"]);
  assert.equal(fallbackRuntime.requests[0].options.headers.authorization, "Bearer fixture-fallback");
  const emptyRuntime = load();
  const missing = await mount(emptyRuntime, config).request();
  assert.equal(missing.body.keyConfigured, false);
  assert.equal(missing.body.ok, false);
  assert.equal(emptyRuntime.requests.length, 0);
  const defaultRuntime = load();
  assert.equal((await mount(defaultRuntime, {}, { COMMANDCODE_API_KEY: "fixture-default" }).request()).body.ok, true);
  let attempts = 0;
  const retryRuntime = load();
  retryRuntime.respond(async (url) => {
    if (++attempts === 1) throw new TypeError("模拟连接失败");
    return { status: 200, json: async () => responses[new URL(url).pathname] };
  });
  assert.equal((await mount(retryRuntime, config, { PRIMARY_TEST_KEY: "fixture-primary" }).request("/__dsh-commandcode-quota/dashboard?scope=quick")).body.ok, true);
  assert.equal(attempts, 2);
  const timeoutRuntime = load();
  timeoutRuntime.respond((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("模拟超时")), { once: true });
  }));
  assert.equal((await mount(timeoutRuntime, { ...config, timeoutMs: 5 }, { PRIMARY_TEST_KEY: "fixture-primary" }).request("/__dsh-commandcode-quota/dashboard?scope=quick")).body.ok, false);
  assert.equal(timeoutRuntime.requests.length, 1, "主动超时不重试");
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
  console.log("通过：宿主端导出、路由、包名与 bundle 补丁层一致。");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
