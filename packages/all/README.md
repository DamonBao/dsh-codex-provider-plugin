# @jcy2387/dsh-suite

`@jcy2387/dsh-suite` is a pure DeepSeek Harness bundle. It contains no Host or Client runtime code; its bundle patch enables two independent plugins together:

- [`@jcy2387/dsh-codex-provider`](../codex-provider): the Codex provider plugin.
- [`@jcy2387/dsh-conversation-ui`](../conversation-ui): the Conversation UI plugin.

## Installation

Install the Suite package in a DSH workspace:

```sh
pnpm add @jcy2387/dsh-suite
```

The package's `dsh.bundle.patch` metadata applies `cordis.patch.yml`, which explicitly inserts both plugins. To install or configure either plugin independently, install its package directly instead.
