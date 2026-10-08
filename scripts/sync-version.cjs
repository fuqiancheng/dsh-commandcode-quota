#!/usr/bin/env node
// 把 package.json 的版本同步进 src/index.js 的 user-agent 行。
//
// 由 npm 的 "version" 生命周期脚本调用。该钩子的执行时机是：
// package.json 的 version 已更新，但改动尚未 commit —— 所以这里改完文件后
// 再 git add，就能和版本号进入同一个 commit。
//
// 手动执行也可以：node scripts/sync-version.cjs
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const target = path.join(root, "src", "index.js");
const source = fs.readFileSync(target, "utf8");

const USER_AGENT = /("user-agent":\s*")[^"]*(")/;
const wanted = `${manifest.name}/${manifest.version}`;

if (!USER_AGENT.test(source)) {
  console.error(`[sync-version] src/index.js 里找不到 user-agent 行，无法同步到 ${wanted}`);
  process.exit(1);
}

const next = source.replace(USER_AGENT, `$1${wanted}$2`);

if (next === source) {
  console.log(`[sync-version] user-agent 已是 ${wanted}，无需修改`);
  process.exit(0);
}

fs.writeFileSync(target, next);
console.log(`[sync-version] user-agent 已更新为 ${wanted}`);
