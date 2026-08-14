# @jcy2387/dsh-codex-provider-plugin

English | [中文](README.zh.md)

An independently published OpenAI Codex provider for DeepSeek Harness, installable with `dsh plugin add`. It uses ChatGPT OAuth, registers `openai-codex` through the native Harness LLM service, and adds browser and device-code sign-in controls to the Web Settings UI.

This package does not modify the `deepseek-harness` source tree and does not run Codex as a subagent. Codex models use the normal Harness agent loop, tools, permissions, sessions, streaming, and compaction pipeline.

> This plugin uses pi-ai's `openai-codex` provider to access the ChatGPT Codex backend. It is not an OpenAI Platform API-key integration. OpenAI controls endpoint behavior, model availability, and quotas, which may change. Use it only in ways permitted by your account and applicable terms.

## Architecture

One npm package ships two runtime faces:

- **Host:** registers the `openai-codex` LLM adapter, stores OAuth state through the Harness credential provider, and exposes a plugin-owned, loopback-only Connection RPC.
- **Browser:** loads through the `dsh.client` manifest and registers a native Settings page. It receives secret-free authentication state only; tokens never enter the browser.

`cordis.patch.yml` inserts one self-owned plugin row. The package neither imports nor modifies `@deepseek-ai/dsh-api-remotes`, so installation requires no static Remote registration in Harness.

Model ids, `contextWindow`, and `maxTokens` come directly from pi-ai's Codex catalog. Harness reads them through its normal `ctx.llm.resolveModelInfo()` path, so session context budgets and automatic compaction need no provider-specific integration.

## Install from npm

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider-plugin
dsh web
```

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
```

- `credentialRef`: reference used by the Harness credential provider for serialized OAuth state.
- `transport`: `sse`, `websocket`, `websocket-cached`, or `auto`.
- `timeoutMs`: provider request timeout.
- `websocketConnectTimeoutMs`: WebSocket connection timeout.
- `streamIdleTimeoutMs`: maximum idle interval while waiting for the next stream chunk.
- `retryPolicy`: standard Harness LLM retry configuration.

## MVP scope

The MVP includes the provider, OAuth lifecycle, native Settings UI, model catalog, and context metadata used by compaction. It does not yet fetch or display remaining Codex quota. That feature should use a separate, plugin-owned secret-free RPC over the ChatGPT usage endpoint.

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
