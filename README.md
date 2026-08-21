# DSH Codex Suite

[![CI](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-green.svg)](#development)
[![pnpm](https://img.shields.io/badge/pnpm-11-orange.svg)](#development)

English | [简体中文](README.zh.md)

A suite of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins that brings **ChatGPT/OpenAI Codex models** and a **Codex-style conversation experience** to the DSH Web UI.

The repository is a pnpm monorepo containing two independent runtime plugins and one pure bundle package:

| Package | Kind | What it does |
| --- | --- | --- |
| [`@jcy2387/dsh-codex-provider`](packages/codex-provider) | Runtime plugin | Registers the `openai-codex` provider with ChatGPT OAuth login, proactive token refresh, usage dashboard, proxy-aware networking, and a native Settings page. |
| [`@jcy2387/dsh-conversation-ui`](packages/conversation-ui) | Runtime plugin | Re-renders the Web chat as a Codex-style event stream: turn folding, semantic tool activity, streaming reveal, deliverables, and smooth viewport follow. |
| [`@jcy2387/dsh-suite`](packages/all) | Pure bundle | No runtime code — a single profile patch that installs both plugins at once. |

The two plugins are fully decoupled: the Conversation UI works with any model, and the Codex Provider works with the stock chat UI.

---

## Why this suite

**Codex Provider — reliable ChatGPT access without an API key**

- **ChatGPT OAuth, both flows.** Browser-based login with device-code fallback. Login failures are classified into secret-free, localized reasons (region restrictions, callback port conflicts, token exchange errors, network issues…) instead of raw stack traces.
- **IPv6 loopback callback bridge.** pi-ai's OAuth listener only binds IPv4; on IPv6-preferred hosts the suite transparently relays the loopback callback, so login still works.
- **Proactive token refresh.** Access tokens rotate ~5 minutes before expiry with retry backoff; a dead refresh token is detected precisely and surfaces as *reconnect required* instead of failing mid-stream.
- **Usage dashboard.** Plan type, credits, and primary/secondary rate-limit windows with used-percent bars and reset times, fetched from the account-scoped ChatGPT endpoint.
- **Proxy-aware networking.** Auto-detects environment and system proxies (macOS / Windows / Linux), routes only OpenAI traffic through them, keeps loopback direct, and exposes an explicit proxy mode (auto / environment / off).
- **Reliability-first defaults.** SSE transport by default (no partial-output duplication on WebSocket failure), 5-minute stream idle timeout, configurable retry policy.
- **Native Settings page** at *Settings → OpenAI Codex* with zh/en localization, live status, and a loopback-only RPC boundary — credentials never leave the Host.

**Conversation UI — the chat rendered like Codex CLI**

- **One ordered event stream.** Process updates, thinking, tool calls, retries, workflows, compaction, and commands appear in natural order within each turn.
- **Turn folding.** A turn starts with an elapsed timer and a thinking placeholder; once the final answer lands, the process section collapses automatically (expandable, with a durable *auto-expand thinking* preference).
- **Semantic tool icons.** Search, file read/edit, shell, database, web, skill, and agent tools each get a distinct icon so activity is scannable at a glance.
- **Two reveal modes.** `teleprompter` (default): instant snapshots gliding upward; `typewriter`: grapheme-safe progressive reveal. Three smoothing presets (`realtime` / `balanced` / `silky`) tune the cadence.
- **Smart viewport follow.** New content is followed within bounded scroll speeds; scrolling up releases the follow, returning to the bottom resumes it. Respects `prefers-reduced-motion` and degrades gracefully under low frame rates.
- **Deliverables card.** Each finished turn lists produced files and websites with added/removed line counts.

---

## Installation

Prerequisites: DeepSeek Harness (`dsh`) with the `web` profile, Node.js `^22.19 || >=24`, pnpm 11.

**Install the whole suite (recommended):**

```sh
dsh plugin --profile web add @jcy2387/dsh-suite
dsh web
```

**Or install plugins individually:**

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
dsh web
```

**Local development** — link a workspace package instead of the published one:

```sh
dsh plugin --profile web add link:$PWD/packages/codex-provider
dsh plugin --profile web add link:$PWD/packages/conversation-ui
dsh web
```

Install **either** the suite **or** the individual plugins in a given profile — not both copies of the same plugin. Coexistence does not crash (the suite mounts its plugins inside a nested loader group, which avoids duplicate loader entry ids), but a direct install and the suite's copy share one loader entry: removing either side from the bundle list of a *running* dsh process silently stops that plugin until the next restart. Restart dsh after any bundle-list change.

## Quick start

1. Install the suite (see above) and open the Web UI (`dsh web`).
2. Go to **Settings → OpenAI Codex**, click **Connect**, and choose **Browser login** (or **Device login** on a headless/remote machine). Complete the ChatGPT authorization.
3. Back in the chat, pick an `openai-codex` model in the model selector and start talking.
4. Optional: review the usage panel in the same settings page, and tune the conversation stream in **Settings → Plugins → Plugin configuration**.

## Configuration

Both plugins are configured through the profile's `cordis.patch.yml` overlay; user-level preferences live in the Settings UI and persist across restarts.

**Codex Provider** (profile patch ID: `codex-provider`)

| Option | Values | Default | Notes |
| --- | --- | --- | --- |
| `transport` | `sse` \| `websocket` \| `websocket-cached` \| `auto` | `sse` | SSE avoids duplicating partial output if a stream fails late. |
| `streamIdleTimeoutMs` | positive integer | `300000` | Max idle interval while reading one response stream. |
| `timeoutMs` / `websocketConnectTimeoutMs` | positive integer | — | Optional request-level timeouts. |
| `retryPolicy` | retry policy object | built-in | Request retry behavior. |
| `credentialRef` | credential reference | `OPENAI_CODEX_OAUTH` | Harness credential slot holding the OAuth state. |
| `ipv6CallbackBridge` | boolean | `true` | Relay the OAuth loopback callback for IPv6-only hosts. |
| `proactiveRefresh` | boolean | `true` | Refresh tokens ahead of expiry. |
| `proxyMode` | `auto` \| `environment` \| `off` | `auto` | Restart-applied; also editable in the Settings page. |

**Conversation UI** (profile patch ID: `conversation-ui`)

| Option | Values | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `teleprompter` \| `typewriter` | `teleprompter` | Reveal style of assistant content. |
| `preset` | `realtime` \| `balanced` \| `silky` | `balanced` | Smoothing cadence. |
| `revealCharsPerSec` | 5–200 | `80` | Typewriter reveal rate. |
| `scrollSpeedPxPerSec` | 1–200 | `48` | Minimum viewport-follow speed. |
| `maxScrollSpeedPxPerSec` | 1–2000 | `1000` | Follow speed ceiling; prevents teleporting after a large lag. |

To temporarily disable the Conversation UI without uninstalling it, apply the bundled [`conversation-ui-off.yml`](packages/conversation-ui/conversation-ui-off.yml) overlay:

```yaml
- id: conversation-ui
  disabled: true
```

### Settings surfaces

| Location | Controls |
| --- | --- |
| Settings → OpenAI Codex | Connect/disconnect account, login method, usage dashboard, proxy mode. |
| Settings → Plugins → Plugin configuration | Auto-expand thinking (live), plugin version, one-click update for npm installs. |

## Architecture

Each runtime plugin ships two halves:

- **Host half** (Node) — Cordis plugin: provider registration, OAuth lifecycle, networking, settings persistence. Loaded from the package root.
- **Web half** (browser) — React views discovered through the `dsh.client` manifest. The Codex Provider contributes the Settings section; the Conversation UI replaces the assistant node view and wraps tool rows.

The halves communicate through two narrow channels: an inline **boot-config global** (`window.__DSH_CONVERSATION_UI_CONFIG__`) injected into the served HTML carries validated plugin config to the browser, and **loopback-authority RPC** carries settings reads/writes back to the Host. Secrets (tokens, proxy URLs) never cross the RPC boundary.

Package-level docs: [codex-provider](packages/codex-provider/README.md) · [conversation-ui](packages/conversation-ui/README.en.md) · [suite](packages/all/README.md)

## Development

Requirements: Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7`.

```sh
pnpm install
pnpm run check        # typecheck + test + build + pack dry-run, same as CI
```

Per-package commands:

```sh
pnpm --filter @jcy2387/dsh-codex-provider check      # typecheck + test + build + publint
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
pnpm --dir packages/all pack --dry-run
```

Tests run on [vitest](https://vitest.dev) — 13 suites covering the OAuth state machine, token refresh, network/proxy detection, usage parsing, the settings controllers, and the streaming client views. CI additionally checks out the DSH source tree at the pinned revision the workspace depends on, verifies release tags match all three package versions, and audits the published tarball contents.

### Repository layout

```text
.
├─ packages/
│  ├─ codex-provider/     # @jcy2387/dsh-codex-provider
│  │  ├─ src/             # Host half: OAuth, refresh, network, usage, LLM adapter
│  │  ├─ src/client/      # Web half: Settings section UI
│  │  ├─ tests/           # 10 vitest suites
│  │  └─ cordis.patch.yml
│  ├─ conversation-ui/    # @jcy2387/dsh-conversation-ui
│  │  ├─ src/             # Host half: config bridge, settings RPC
│  │  ├─ src/client/      # Web half: stream views, cards, follow engine
│  │  ├─ tests/           # 3 vitest suites
│  │  └─ cordis.patch.yml
│  └─ all/                # @jcy2387/dsh-suite (pure bundle, no runtime code)
├─ .github/workflows/ci.yml
├─ pnpm-workspace.yaml
└─ README.md / README.zh.md
```

## Troubleshooting

- **Browser login never completes** — the callback bridge listens on `127.0.0.1:1455`; make sure the port is free and the browser can reach loopback. The settings page classifies the exact failure (port conflict, timeout, state mismatch…).
- **Region not supported** — OpenAI rejects the login for unsupported regions; the settings page surfaces this as a distinct reason. A proxy (`proxyMode`) can change the egress route (restart required).
- **`reauth required` after some time** — the refresh token expired or was revoked (e.g. password change). Reconnect once from the settings page.

## License

[MIT](LICENSE) © jcy2387
