# @jcy2387/dsh-suite

[![CI](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A pure [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle: it contains **no Host or Client runtime code** — just a `cordis.patch.yml` whose single profile patch installs two independent plugins together. Part of the [DSH Codex Suite](../../README.md) monorepo.

## What it installs

- [`@jcy2387/dsh-codex-provider`](../codex-provider/README.md) — the Codex provider: ChatGPT OAuth, usage dashboard, proxy-aware networking, native Settings page.
- [`@jcy2387/dsh-conversation-ui`](../conversation-ui/README.en.md) — the Codex-style conversation UI: event stream, turn folding, streaming reveal, deliverables.

Both plugins remain independently configurable; the suite only wires them into the profile. To install or configure just one of them, install its package directly instead.

## Install

```sh
dsh plugin --profile web add @jcy2387/dsh-suite
dsh web
```

After installing, follow each plugin's quick start: connect a ChatGPT account in **Settings → OpenAI Codex**, then pick an `openai-codex` model — the conversation UI activates automatically for new conversations.

## How the bundle works

The package's `dsh.bundle.patch` metadata points at `cordis.patch.yml`, which inserts both plugins inside a nested loader group:

```yaml
- insert:
    - id: suite-plugins
      name: cordis:group
      group: true
      config:
        - id: codex-provider
          name: '@jcy2387/dsh-codex-provider'
          disabled: !!js ctx.loader.store['codex-provider'] !== undefined
        - id: conversation-ui
          name: '@jcy2387/dsh-conversation-ui'
          disabled: !!js ctx.loader.store['conversation-ui'] !== undefined
```

The `disabled` expressions make the bundle **idempotent**: if a profile already contains one of the plugins installed directly (a common case when it was installed before the suite), the direct row keeps ownership and the suite's copy stands down — no duplicate loader entries. Remove the direct install to let the suite own that plugin.

## Development

The package has no build step; it only ships `cordis.patch.yml`, this README, and the license.

```sh
pnpm --dir packages/all pack --dry-run    # from the monorepo root
```

CI audits the published tarball to confirm it contains the patch and no runtime bundles. See the [monorepo README](../../README.md) for workspace-wide commands.

## License

[MIT](LICENSE) © jcy2387
