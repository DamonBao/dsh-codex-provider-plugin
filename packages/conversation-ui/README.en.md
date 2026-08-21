# @jcy2387/dsh-conversation-ui

A Codex-style conversation UI enhancement plugin for DeepSeek Harness. It presents process updates, thinking, tool activity, and final answers as one ordered event stream while keeping viewport follow smooth.

## Features

- Shows immediate Turn progress and a thinking placeholder after submission.
- Separates process content from the final answer and folds completed Turns automatically.
- Keeps Think, Tool, Retry, Workflow, Compaction, Command, and context-injection rows in order.
- Uses semantic icons for search, read, edit, shell, data, web, skill, agent, and related tools.
- Supports `teleprompter` (immediate snapshots, default) and `typewriter` (grapheme-safe reveal) modes.
- Follows new content smoothly, releases follow while the reader scrolls upward, and resumes at the bottom.
- Respects `prefers-reduced-motion` and low-FPS protection.
- Adds a durable “Auto-expand thinking” preference to the plugin settings page.

The package is independent from the Codex Provider and can enhance conversations using other models.

## Install

For local development:

```sh
dsh plugin --profile web add link:/path/to/dsh-codex-suite/packages/conversation-ui
dsh web
```

For a published package:

```sh
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
dsh web
```

Alternatively install `@jcy2387/dsh-suite` to enable both the Codex Provider and this package.

### Temporarily disable

`conversation-ui-off.yml` is an optional profile overlay. It disables the plugin without removing its package:

```yaml
- id: conversation-ui
  disabled: true
```

## Configuration

The bundle defaults to `mode: teleprompter` and `preset: balanced`. Override these values in the profile `cordis.patch.yml`:

| Option | Values / meaning |
| --- | --- |
| `mode` | `teleprompter` or `typewriter` |
| `preset` | `realtime`, `balanced`, or `silky` |
| `revealCharsPerSec` | Typewriter reveal speed |
| `scrollSpeedPxPerSec` | Minimum viewport-follow speed |
| `maxScrollSpeedPxPerSec` | Maximum viewport-follow speed |

Open **Settings → Plugins → Plugin configuration** to change “Auto-expand thinking”. This is a durable user preference and takes effect immediately after saving.

## Development

```sh
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
```

## License

[MIT](LICENSE)
