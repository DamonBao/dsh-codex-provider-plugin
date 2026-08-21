# @jcy2387/dsh-codex-provider

OpenAI Codex OAuth provider for DeepSeek Harness.

This package registers the `openai-codex` provider, manages ChatGPT OAuth credentials, exposes usage and network settings, and adds the native OpenAI Codex Settings page. It is the Provider package in the `dsh-codex-suite` monorepo.

## Install

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh web
```

Open **Settings → OpenAI Codex** to connect a ChatGPT account, then select an `openai-codex` model in the normal model picker.

## Development

```sh
pnpm --filter @jcy2387/dsh-codex-provider check
```
