// 用轻量 React/请求替身测试前端；不访问网络，不操作 DSH 进程。
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const plugin = join(__dirname, "..");
const fixture = {
  ok: true, providerId: "cc2",
  providers: [{ id: "cc1", label: "账号 1" }, { id: "cc2", label: "账号 2" }],
  balance: { monthlyCredits: 70 },
  usage: { totalMonthlyCredits: 30, totalTokens: 100, totalCost: 5, successRate: 98 },
  windowLimits: { fiveHour: { used: 10, cap: 100 }, weekly: { used: 20, cap: 100 } },
  // 月度窗口的重置时间取自订阅周期末，是 ISO 字符串而非毫秒数
  subscription: { status: "active", currentPeriodEnd: new Date(Date.now() + 20 * 86400000).toISOString() },
};
function mount({ open = true, data = fixture, failed = false } = {}) {
  let registration, component, slot, stateIndex = 0;
  const values = [open, data, false, null];
  const updates = [], callbacks = [], effects = [], requests = [], timers = [];
  const React = {
    Fragment: "fragment",
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) {
      const index = stateIndex++;
      return [index < values.length ? values[index] : initial, value => updates.push({ index, value })];
    },
    useCallback(fn, deps) { callbacks.push({ fn, deps }); return fn; },
    useEffect(fn) { effects.push(fn); },
    useRef(value) { return { current: value }; },
  };
  vm.runInNewContext(fs.readFileSync(join(plugin, "src/client.js"), "utf8"), {
    window: { __ModuleLoader__: { load(row) { registration = row; } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: !failed, status: failed ? 503 : 200, json: async () => fixture };
    },
    setInterval(fn, ms) { timers.push({ fn, ms }); return 1; },
    clearInterval(id) { timers.push({ cleared: id }); },
  });
  assert.equal(registration.id, "dsh-commandcode-quota");
  const client = registration.factory(() => React);
  assert.deepEqual(Array.from(client.inject), ["slots"]);
  client.apply({ slots: {
    inject(name, fn) { assert.equal(name, "conversation.composer.dock"); fn(); },
    register(row, fn) { slot = row; component = fn; },
  } });
  assert.equal(slot.id, "dsh-commandcode-quota-dashboard");
  assert.equal(slot.order, -1);
  const tree = component(), nodes = [], texts = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node == null || typeof node === "boolean") return;
    if (typeof node !== "object") return texts.push(String(node));
    if (typeof node.type === "function") return visit(node.type(node.props));
    nodes.push(node);
    visit(node.children);
  }
  visit(tree);
  return { nodes, texts, updates, callbacks, effects, requests, timers, stateIndex };
}
async function main() {
  const view = mount();
  const buttons = view.nodes.filter(node => node.type === "button");
  assert.equal(buttons.length, 3, "只保留状态栏、刷新和关闭按钮，不应存在账号切换按钮");
  assert.equal(view.stateIndex, 4, "不再维护选中账号状态");
  assert.equal(view.callbacks[0].deps.length, 0);
  for (const label of ["5h 10%", "周 20%", "月 30%", "$70.00", "5 小时窗口", "每周窗口", "每月窗口"]) {
    assert.ok(view.texts.includes(label), `保留额度展示：${label}`);
  }
  // 回归：月度重置时间来自 ISO 字符串，未经 toMs 归一化会渲染成 "NaN分NaN秒"
  const resetTexts = view.texts.filter((t) => t.includes("重置"));
  assert.equal(resetTexts.length, 3, "三个窗口都应显示重置信息");
  for (const t of resetTexts) assert.ok(!t.includes("NaN"), `重置文本不应出现 NaN：${t}`);
  assert.ok(
    resetTexts.some((t) => /\d+天\d+小时（\d{4}\/\d{2}\/\d{2}）/.test(t)),
    `月度应显示天级倒计时与到期日，实际：${resetTexts.join(" | ")}`,
  );
  await buttons.find(node => node.props.title === "刷新").props.onClick();
  assert.deepEqual(view.requests.map(req => req.url), ["/__dsh-commandcode-quota/dashboard?scope=quick", "/__dsh-commandcode-quota/dashboard"]);
  assert.ok(view.requests.every(req => req.options.cache === "no-store"));
  assert.ok(!view.updates.some(update => update.index > 3));
  const timerView = mount({ open: false, data: null });
  assert.equal(timerView.nodes.filter(node => node.type === "button").length, 1);
  const cleanup = timerView.effects[0]();
  assert.equal(timerView.timers[0].ms, 3 * 60 * 1000);
  cleanup();
  assert.equal(timerView.timers[1].cleared, 1);
  const failure = mount({ failed: true });
  await failure.callbacks[0].fn();
  assert.ok(failure.updates.some(update => update.index === 3 && update.value.includes("HTTP 503")));
  assert.ok(failure.updates.some(update => update.index === 2 && update.value === false));
  const manifest = JSON.parse(fs.readFileSync(join(plugin, "package.json"), "utf8"));
  assert.equal(manifest.name, "dsh-commandcode-quota", "客户端注册 id 必须等于包名");
  assert.equal(manifest.exports["./client"], "./src/client.js", "必须导出 ./client 供客户端模块加载");
  for (const file of ["locale/en.json", "locale/zh.json"]) {
    const meta = JSON.parse(fs.readFileSync(join(plugin, file), "utf8"));
    assert.ok(meta.meta?.title && meta.meta?.description, `${file} 必须提供标题与描述`);
  }
  console.log("通过：无账号切换；额度展示、手动/定时刷新、错误处理、槽位注册保持可用。");
  console.log("通过：包名与客户端注册 id 一致，locale 为合法 JSON。");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
