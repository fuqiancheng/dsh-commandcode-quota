# dsh-commandcode-quota

A **Command Code balance and quota panel** for DeepSeek Harness (DSH).

The plugin renders a compact status row directly underneath the DSH composer:

- **5-hour, weekly and monthly usage windows** as live percentages
- **Available balance**
- Click the row to expand the full breakdown: used / limit / remaining / reset time, total spend, tokens, success rate, subscription and account information

It is **single-account by design**. There is no account switcher, and your API key never reaches the browser.

## Requirements

- DeepSeek Harness with the Web client (`dsh web` or the desktop app)
- Node.js 20 or newer
- A Command Code API key

## Install

### From npm (recommended)

```bash
dsh plugin add dsh-commandcode-quota
```

DSH expands the bundled `cordis.patch.yml` into your profile, so no manual patch editing is needed.

### From a local checkout

```bash
dsh plugin add file:/path/to/dsh-commandcode-quota
```

### Manual junction (desktop app)

The Electron desktop profile is managed by the application and does not run the `dsh plugin add` reconciliation, so register it yourself.

Link the package into the shared resolution pool:

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-commandcode-quota" `
  -Target "C:\path\to\dsh-commandcode-quota"
```

Then add this to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-commandcode-quota
      name: 'dsh-commandcode-quota'
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

> The junction name must be exactly the package name, otherwise the host cannot resolve the import.

After installing or changing the plugin, reload the plugin tree (the plugin page's refresh action, or a client restart).

## Configuration

| Key | Default | Description |
|---|---|---|
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | Credential entry resolved through DSH's credentials service |
| `fallbackEnv` | — | Optional second entry, used only when the first one is missing |
| `baseURL` | `https://api.commandcode.ai` | Command Code API origin |
| `timeoutMs` | `30000` | Per-request timeout in milliseconds |

Credentials live in `~/.dsh/.credentials.yaml`, or in DSH Settings → Credentials. Never commit them.

## How it works

The package has two halves:

- **Host half** (`src/index.js`) resolves the key through the DSH credentials service and registers a read-only HTTP endpoint that fans out to the Command Code API, then aggregates the responses into a single payload. The key is read on every request and never serialized to the client.
- **Client half** (`src/client.js`) registers a status row into the composer dock slot, polls the host endpoint, and renders it with DSH theme tokens so light and dark themes both work.

Data comes from four Command Code endpoints, each called with `Authorization: Bearer <key>`:

| Endpoint | Used for |
|---|---|
| `GET /alpha/billing/credits` | Balance and the 5-hour / weekly limits |
| `GET /alpha/usage/summary` | Spend, tokens and success rate |
| `GET /alpha/billing/subscriptions` | Subscription status and period boundaries |
| `GET /alpha/whoami` | Account information |

The monthly window is composed from the usage total plus the remaining credits, with the reset time taken from the subscription period.

### Behaviour under failure

- The four requests run in parallel, so total latency is the slowest one rather than the sum.
- A connection-level failure is retried once; a deliberate timeout is not retried.
- On failure the panel falls back to the last successful value (kept in-process for 6 hours) and reports it as stale.
- An HTTP 401 is never masked by cached data, because it means the credential itself is wrong.

## Development

```bash
npm test                        # host and client unit tests; no network, no DSH process
node --check src/index.js       # host half syntax
node --check src/client.js      # client half syntax
```

The tests stub the credentials service, the web server, `fetch` and React, so they run offline and never touch a live DSH instance.

## License

MIT
