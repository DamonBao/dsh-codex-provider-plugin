# @jcy2387/dsh-codex-provider-plugin

English | [中文](README.zh.md)

An independently published OpenAI Codex provider for DeepSeek Harness, installable with `dsh plugin add`. It uses ChatGPT OAuth, registers `openai-codex` through the native Harness LLM service, and adds browser and device-code sign-in controls to the Web Settings UI.

This package does not modify the `deepseek-harness` source tree and does not run Codex as a subagent. Codex models use the normal Harness agent loop, tools, permissions, sessions, streaming, and compaction pipeline.

> This plugin uses pi-ai's `openai-codex` provider to access the ChatGPT Codex backend. It is not an OpenAI Platform API-key integration. OpenAI controls endpoint behavior, model availability, and quotas, which may change. Use it only in ways permitted by your account and applicable terms.

## Architecture

One npm package ships two runtime faces:

- **Host:** registers the `openai-codex` LLM adapter, stores OAuth state through the Harness credential provider, fetches account usage, and exposes a plugin-owned, loopback-only Connection RPC.
- **Browser:** loads through the `dsh.client` manifest and registers a native Settings page. It receives only validated, secret-free authentication and usage snapshots; tokens and account ids never enter the browser.

Harness currently exposes Settings sections as a flat list and the Models page has no external content slot. The plugin therefore stays on an independent **OpenAI Codex** page ordered immediately after **Models**, rather than patching Harness or injecting brittle DOM content.

`cordis.patch.yml` inserts one self-owned plugin row. The package neither imports nor modifies `@deepseek-ai/dsh-api-remotes`, so installation requires no static Remote registration in Harness.

Model ids, `contextWindow`, and `maxTokens` come directly from pi-ai's Codex catalog. Harness reads them through its normal `ctx.llm.resolveModelInfo()` path, so session context budgets and automatic compaction need no provider-specific integration.

## Install from npm

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider-plugin
dsh web
```

## Set up OpenAI Codex

> This plugin uses ChatGPT OAuth, not an `OPENAI_API_KEY` or OpenAI Platform API key.

The settings page looks like this:

<p align="center">
  <img src="./docs/images/openai-codex-settings.svg" alt="OpenAI Codex settings page in DeepSeek Harness" width="900">
</p>

1. Start the Web UI with `dsh web`.
2. Open **Settings → OpenAI Codex** and click **Connect Codex**.
3. Choose **Browser sign-in** and authorize with your ChatGPT account, or choose **Device code sign-in** for a headless/remote Host.
4. After the status becomes **Connected**, the page displays the usage windows currently returned by OpenAI and refreshes them every 60 seconds. Removed or unavailable windows are not shown; no five-hour limit is hardcoded.
5. Select a model under `openai-codex` in the normal model picker. Installing the plugin does not change the default model.

Browser sign-in requires the browser and dsh Host to run on the same machine. Device-code sign-in may need to be enabled in ChatGPT security settings or workspace permissions. Your account or workspace must have Codex access; model availability and quotas are controlled by OpenAI. Usage comes from OpenAI's account-scoped ChatGPT endpoint and may change with that service.

## Upgrade

Plugins are installed independently for each dsh profile. Upgrade this plugin in the `web` profile to the newest published version:

```sh
dsh plugin --profile web update @jcy2387/dsh-codex-provider-plugin --latest
```

To install an exact version instead:

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider-plugin@0.1.0-rc.7 --save-exact
```

Verify the installed version, restart `dsh web`, and force-refresh the browser so it does not reuse the previous client bundle:

```sh
dsh plugin --profile web list @jcy2387/dsh-codex-provider-plugin --depth 0
```

When running from a `deepseek-harness` source checkout, prefix these commands with `pnpm`.

## Local development installation

```sh
pnpm install
pnpm run check
dsh plugin --profile web add link:/Users/baojie/Documents/Projects/github/dsh-codex-provider-plugin
dsh web
```

From a `deepseek-harness` source checkout, prefix the last two commands with `pnpm`:

```sh
pnpm dsh plugin --profile web add link:/Users/baojie/Documents/Projects/github/dsh-codex-provider-plugin
pnpm dsh web
```

Open **Settings → OpenAI Codex**, then choose browser sign-in or device-code sign-in. Installation only adds a provider; it does not change the default model. Select a model under `openai-codex` through the normal model picker.

## Configuration

Every field is optional:

```yaml
- id: llm-openai-codex
  config:
    credentialRef: OPENAI_CODEX_OAUTH
    transport: auto
    streamIdleTimeoutMs: 300000
    ipv6CallbackBridge: true
```

- `credentialRef`: reference used by the Harness credential provider for serialized OAuth state.
- `transport`: `sse`, `websocket`, `websocket-cached`, or `auto`.
- `timeoutMs`: provider request timeout.
- `websocketConnectTimeoutMs`: WebSocket connection timeout.
- `streamIdleTimeoutMs`: maximum idle interval while waiting for the next stream chunk.
- `retryPolicy`: standard Harness LLM retry configuration.
- `ipv6CallbackBridge`: temporarily bridge `[::1]:1455` to pi-ai's `127.0.0.1:1455` listener during browser sign-in. Enabled by default; disable it when `PI_OAUTH_CALLBACK_HOST` is explicitly managed by the deployment. The IPv4 port-availability check remains active when only the bridge is disabled.

## Authentication troubleshooting

The Settings UI reports a stable diagnostic code without returning OAuth responses or tokens to the browser:

| Code | Meaning and next check |
| --- | --- |
| `CODEX_AUTH_ACCOUNT_ACCESS` | OpenAI did not issue usable Codex credentials. Check MFA, the selected ChatGPT workspace, and workspace Codex permissions. |
| `CODEX_AUTH_BROWSER_CALLBACK` | Authorization did not reach the Host. Run the browser on the Host machine and check whether `localhost:1455` is blocked or occupied. The default IPv6 bridge handles systems that resolve `localhost` to `::1`. |
| `CODEX_AUTH_DEVICE_CODE_DISABLED` | Enable device-code sign-in in personal ChatGPT security settings or workspace permissions. |
| `CODEX_AUTH_NETWORK` | Check the Host's proxy, DNS, TLS trust, and firewall access to OpenAI authentication services. |
| `CODEX_AUTH_TOKEN_EXCHANGE` | Authorization returned but credential exchange failed. Retry, then check the Host clock and proxy. |
| `CODEX_AUTH_UNSUPPORTED_REGION` | Browser authorization completed, but the Host network exits from a country or region OpenAI does not support. Use a Host network that complies with OpenAI availability and terms, then start a new login. |
| `CODEX_AUTH_UNKNOWN` | Test official Codex sign-in on the same Host to separate an account/environment failure from a plugin compatibility issue. |

Browser sign-in redirects to `http://localhost:1455/auth/callback`, so it is suitable only when the browser and dsh Host run on the same machine. Before starting pi-ai, the plugin verifies that `127.0.0.1:1455` is available and fails immediately with `CODEX_AUTH_BROWSER_CALLBACK` when another process owns it. While browser login is active, it also opens an IPv6-only `[::1]:1455` listener that redirects the exact callback path and query to pi-ai on IPv4, then closes it when the attempt ends. It never listens on a LAN address. Full provider errors stay in the Host log; the browser receives only the diagnostic codes above. For a headless Host, use device-code sign-in after enabling it for the account or workspace. See [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth).

## Current scope

The plugin includes the provider, OAuth lifecycle, native Settings UI, model catalog, compaction metadata, and Codex usage display. The Host calls `https://chatgpt.com/backend-api/wham/usage` with the refreshed OAuth credential, validates the response, and sends only plan, window percentages, reset timestamps, and optional credit balance over its loopback-only RPC. The UI renders only windows present in the response, so it does not assume a five-hour limit.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run publint
```

Build outputs:

- `lib/index.js`: Host plugin.
- `lib/client.js`: loader-compatible browser plugin with inline CSS Modules.
- `lib/types/**`: Host and browser declarations.
- `cordis.patch.yml`: profile layer activated by the `dsh.bundle` manifest.
