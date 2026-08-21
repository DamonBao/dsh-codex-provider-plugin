# @jcy2387/dsh-codex-provider

[![CI](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh.md)

OpenAI Codex as an installable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) LLM provider — ChatGPT account login instead of API keys, with a native Settings page, usage dashboard, and proxy-aware networking. Part of the [DSH Codex Suite](../../README.md) monorepo.

![OpenAI Codex settings in DeepSeek Harness](docs/images/openai-codex-settings.svg)

## Features

### ChatGPT OAuth, both flows

- **Browser login** opens the ChatGPT authorization page and completes via a loopback callback; **device login** (device code) covers headless or remote machines.
- Login failures are classified on the Host into **secret-free, localized reasons** — region restrictions, callback port conflicts, callback timeout, state mismatch, token-exchange errors, account access, network issues, and more — so the browser never sees raw (potentially sensitive) error text.
- **IPv6 callback bridge:** pi-ai's OAuth listener binds IPv4 only. On hosts where `localhost` resolves to `::1` first, the plugin temporarily listens on the IPv6 loopback and relays the callback to pi-ai's IPv4 listener on port `1455`, so browser login still works.

### Proactive token refresh

- The access token rotates **~5 minutes before expiry** (`marginMs`, default `300_000`).
- Transient refresh failures retry after **60 s, then every 300 s** (`retryDelaysMs`).
- A **terminal** refresh failure (dead refresh token: `invalid_grant`, explicit expiry/revocation, 401/403) is detected precisely — server errors (5xx) and rate limits (429) stay retryable — and surfaces the *reconnect required* state instead of failing mid-stream or condemning a healthy token.

### Usage dashboard

Fetched from the account-scoped ChatGPT endpoint (`chatgpt.com/backend-api/wham/usage`) and rendered in Settings:

- Plan type and credits (balance, or *unlimited*).
- **Primary and secondary rate-limit windows** with used-percent progress bars and localized reset times.
- A *limit reached* notice; auto-refreshes every 60 s while connected, plus a manual refresh button.

### Proxy-aware networking

- Auto-detects proxies from **environment variables** (`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`) and **system settings** — macOS (`scutil --proxy`), Windows registry, and Linux (GNOME `gsettings` / KDE).
- Routes **only OpenAI traffic** (`openai.com`, `chatgpt.com`) through the proxy via a scoped `undici` dispatcher; loopback stays direct and unrelated traffic is untouched.
- Explicit proxy mode setting: `auto` (detect), `environment` (env vars only), or `off` (direct). The active route and any detection issue are shown in Settings; changing the mode applies after a Host restart.

### Reliability-first transport

- Default transport is **`sse`** — upstream `auto` falls back to SSE only before WebSocket stream events begin, so a late WebSocket failure would otherwise duplicate partial output by replaying the request.
- **5-minute stream idle timeout** (configurable) bounds a hung response without killing slow thinking turns.
- Configurable request timeouts and retry policy.

### Security boundaries

- OAuth state persists in the Harness **credentials store** (default ref `OPENAI_CODEX_OAUTH`); tokens never cross the browser RPC, which is registered with **loopback-only authority**.
- Usage responses from OpenAI are validated and redacted before reaching the UI.

## Install

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh web
```

For a local development copy:

```sh
dsh plugin --profile web add link:/path/to/dsh-codex-suite/packages/codex-provider
dsh web
```

The plugin works in headless profiles too — the Web client half is optional; account management then happens through the browser on a loopback session.

## Quick start

1. Open **Settings → OpenAI Codex** and click **Connect**.
2. In the login modal choose **Browser login** (or **Device login** on a remote machine) and complete ChatGPT authorization. Progress is shown live; you can cancel at any time.
3. Once connected, pick an `openai-codex` model in the normal model selector and start chatting.

The same settings page also shows the usage dashboard and the proxy mode control while connected. Account actions (connect/disconnect/proxy) are only enabled when the Web UI is accessed from loopback.

## Configuration

Profile patch ID: `codex-provider`. Set values in the profile's `cordis.patch.yml` overlay.

| Option | Values | Default | Notes |
| --- | --- | --- | --- |
| `transport` | `sse` \| `websocket` \| `websocket-cached` \| `auto` | `sse` | See *Reliability-first transport* above. |
| `streamIdleTimeoutMs` | positive integer | `300000` | Max idle interval while reading one response stream. |
| `timeoutMs` | positive integer | — | Optional overall request timeout. |
| `websocketConnectTimeoutMs` | positive integer | — | Optional WebSocket connect timeout. |
| `retryPolicy` | retry policy object | built-in | Request retry behavior (same schema as other DSH providers). |
| `credentialRef` | credential reference | `OPENAI_CODEX_OAUTH` | Harness credential slot holding the serialized OAuth state. |
| `ipv6CallbackBridge` | boolean | `true` | Relay the OAuth loopback callback for IPv6-preferred hosts. |
| `proactiveRefresh` | boolean | `true` | Refresh access tokens ahead of expiry. |
| `proxyMode` | `auto` \| `environment` \| `off` | `auto` | Also editable in the Settings page; applies after restart. |

Example overlay:

```yaml
- id: codex-provider
  name: '@jcy2387/dsh-codex-provider'
  config:
    transport: sse
    streamIdleTimeoutMs: 300000
    proxyMode: auto
```

## Architecture

The package ships two halves:

- **Host half** (`src/`, exported from the package root) — a Cordis plugin injecting `llm`, `credentials`, and `settings`. It owns the OAuth lifecycle (`CodexAuthService`), token refresh (`CodexTokenRefresher`), network manager, usage service, and registers the provider through `PiAiAdapter` (backed by `@earendil-works/pi-ai`'s `openaiCodexProvider`). The model catalog is validated at load (context window / max tokens must be usable for context budgeting and compaction).
- **Web half** (`src/client/`, bundled to `lib/client.cjs` and discovered via the `dsh.client` manifest) — a React settings section registered into the Web UI's Settings page, localized in Chinese and English.

The halves talk over one **loopback-authority RPC channel** (`status`, `network`, `setProxyMode`, `usage`, `login`, `cancel`, `logout`). Failure reasons crossing this boundary are enum values, not error text.

## Development

```sh
pnpm --filter @jcy2387/dsh-codex-provider check      # typecheck + test + build + publint
pnpm --filter @jcy2387/dsh-codex-provider typecheck
pnpm --filter @jcy2387/dsh-codex-provider test
pnpm --filter @jcy2387/dsh-codex-provider build
```

Ten vitest suites cover the auth state machine and failure classification, the IPv6 callback bridge, terminal-vs-transient refresh detection, proxy discovery (macOS / Windows / Linux / env), usage parsing and redaction, the settings card controller, and the RPC contract.

See the [monorepo README](../../README.md) for workspace-wide commands.

## License

[MIT](LICENSE) © jcy2387
