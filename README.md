# DSH Codex Suite

A pnpm monorepo for DeepSeek Harness plugins. The repository contains two independent runtime plugins and one pure bundle package.

## Packages

- `@jcy2387/dsh-codex-provider` — OpenAI Codex OAuth provider, model catalog, usage, network settings, and native Settings UI.
- `@jcy2387/dsh-conversation-ui` — Codex-style conversation presentation with streaming reveal, Turn process folding, semantic Tool activity, deliverables, and viewport follow.
- `@jcy2387/dsh-suite` — Pure bundle that enables both plugins through one DSH profile patch.

`@jcy2387/dsh-conversation-ui` is the renamed migration of the former `dsh-light-stream` functionality. It does not depend on the Codex Provider and can be used with any model.

## Install

Install one package directly:

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
```

Or install the Suite bundle:

```sh
dsh plugin --profile web add @jcy2387/dsh-suite
```

For local development, replace a package name with `link:$PWD/packages/<package>`.

## Development

Requirements: Node.js 22.19+ and pnpm 11.

```sh
pnpm install
pnpm run check
```

Build or test an individual package:

```sh
pnpm --filter @jcy2387/dsh-codex-provider check
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
pnpm --dir packages/all pack --dry-run
```

The optional `packages/conversation-ui/conversation-ui-off.yml` overlay disables the Conversation UI row without removing the package.

## Profile patch IDs

- `codex-provider`
- `conversation-ui`

See each package README for configuration and package-specific behavior.
