# dsh-commandcode-quota

一个面向 DeepSeek Harness（DSH）的 **Command Code 余额与额度面板**插件。

插件会在 DSH 输入框正下方渲染一行常驻状态栏：

- **5 小时、每周、每月**三个额度窗口的实时百分比
- **可用余额**
- 点击状态栏展开完整明细：已用 / 上限 / 剩余 / 重置时间、总消耗、Tokens、成功率，以及订阅和账户信息

**刻意做成单账号**：没有账号切换，API key 也不会进入浏览器。

## 环境要求

- 带 Web 客户端的 DeepSeek Harness（`dsh web` 或桌面端）
- Node.js 20 及以上
- 一个 Command Code API key

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin add dsh-commandcode-quota
```

DSH 会把包内自带的 `cordis.patch.yml` 展开进你的 profile，不需要手工改补丁。

### 从本地目录安装

```bash
dsh plugin add file:/path/to/dsh-commandcode-quota
```

### 手动链接（桌面端）

桌面端的 Electron profile 由应用托管，不会走 `dsh plugin add` 的展开流程，需要自己注册。

先把包链接进共享解析池：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-commandcode-quota" `
  -Target "C:\path\to\dsh-commandcode-quota"
```

再往 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-commandcode-quota
      name: 'dsh-commandcode-quota'
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

> 链接名必须和包名完全一致，否则宿主端解析不到这个 import。

安装或改动插件后，重载插件树（插件页的「刷新」，或重启客户端）才生效。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | 通过 DSH 凭据服务解析的凭据条目名 |
| `fallbackEnv` | 无 | 可选的备用条目，仅在首选缺失时使用 |
| `baseURL` | `https://api.commandcode.ai` | Command Code API 地址 |
| `timeoutMs` | `30000` | 单次请求超时（毫秒） |

凭据写在 `~/.dsh/.credentials.yaml`，或在 DSH 设置 → 凭据里添加。**不要提交到仓库。**

## 工作原理

包分宿主端和客户端两半：

- **宿主端**（`src/index.js`）通过 DSH 凭据服务解析 key，注册一个只读 HTTP 端点，并发请求 Command Code API 后聚合成一个响应。key 每次请求现读，绝不序列化给客户端。
- **客户端**（`src/client.js`）往输入框的 dock 槽位注册状态栏，轮询宿主端点，并全部使用 DSH 主题 token 渲染，自动适配深色/浅色主题。

数据来自四个 Command Code 接口，均带 `Authorization: Bearer <key>`：

| 接口 | 用途 |
|---|---|
| `GET /alpha/billing/credits` | 余额，以及 5 小时 / 每周限额 |
| `GET /alpha/usage/summary` | 消耗、Tokens、成功率 |
| `GET /alpha/billing/subscriptions` | 订阅状态与周期起止 |
| `GET /alpha/whoami` | 账户信息 |

每月窗口是合成值：已用取用量汇总，总额为已用加剩余额度，重置时间取订阅周期末。

## 失败时的行为

- 四个请求并发发出，总耗时等于最慢的一个，而不是四者之和。
- 连接级失败重试一次；主动超时不重试。
- 请求失败时回退到上次成功的值（进程内保留 6 小时），并标记为陈旧数据。
- HTTP 401 不会被缓存掩盖——它意味着凭据本身有问题，必须让用户看到。

## 开发

```bash
npm test                        # 宿主端与客户端单元测试；不联网、不依赖运行中的 DSH
node --check src/index.js       # 宿主端语法检查
node --check src/client.js      # 客户端语法检查
```

测试对凭据服务、Web 服务器、`fetch` 和 React 都使用了替身，因此可离线运行，也不会碰到真实的 DSH 实例。

## License

MIT
