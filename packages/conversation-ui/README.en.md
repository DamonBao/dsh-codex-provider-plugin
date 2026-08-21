# @jcy2387/dsh-conversation-ui

[![CI](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.md)

A Codex-style conversation UI enhancement plugin for DeepSeek Harness (DSH): the Web chat is re-rendered as one ordered event stream — process updates, thinking, tool activity, retries, workflows, and the final answer appear in the order they happened, while viewport follow stays smooth. This package is the Conversation UI package of the [DSH Codex Suite](../../README.md) monorepo.

**The package is fully independent from the Codex Provider** and can be installed alone to enhance conversations with any model.

## Features

### Event stream and turn structure

- **Instant turn feedback:** an elapsed timer and a thinking placeholder appear the moment you submit — no more staring at a blank screen.
- **Process vs. answer:** each turn's process content (Think, tools, retries…) is grouped into its own section; once the final answer lands successfully, the process section **auto-collapses** and stays expandable by hand.
- **Natural ordering:** Think, Tool, Retry, Workflow, Compaction, Command, and context-injection rows keep their real order instead of being regrouped away.

### Semantic tool activity

- Search, file read, edit, shell, database, web, skill, and agent tools each render a distinct icon, so the activity stream is scannable at a glance; groups collapse and expand.

### Two streaming reveal modes

| Mode | Behavior |
| --- | --- |
| `teleprompter` (default) | Content appears as instant snapshots that glide smoothly upward — read it like a teleprompter. |
| `typewriter` | Progressive reveal by grapheme cluster, safe for CJK text and emoji. |

- Three smoothing presets: `realtime` (snappier), `balanced` (default), `silky` (extra smooth). Presets shape the reveal cadence — EMA-smoothed arrival rate, buffer targets, catch-up ceilings, and the settle drain after the input idles — so long replies never dump whole paragraphs at once and fast streams never stutter.
- `typewriter` mode also exposes a fixed reveal rate via `revealCharsPerSec`.

### Smart viewport follow

- New content is followed smoothly within speed bounds: at least `scrollSpeedPxPerSec`, at most `maxScrollSpeedPxPerSec` (a large lag never teleports).
- Scrolling upward to read **releases the follow**; returning to the bottom resumes it.
- Respects `prefers-reduced-motion`; when the frame rate degrades, an FPS guard skips DOM commits for offscreen replies so visible frames stay fluid.

### Deliverables card

- Every finished turn ends with a **deliverables** card: produced files and websites with added/removed line counts.

### Plugin settings card

- A durable **Auto-expand thinking** toggle in *Settings → Plugins → Plugin configuration* (live; no restart needed).
- The card also shows the current version and installation kind (npm / local development); npm installs get a one-click update action (restart required after updating).
- Localized in Chinese and English.

## Install

Published package:

```sh
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
dsh web
```

Local development copy:

```sh
dsh plugin --profile web add link:/path/to/dsh-codex-suite/packages/conversation-ui
dsh web
```

Alternatively install the [`@jcy2387/dsh-suite`](../all/README.md) bundle to enable both the Codex Provider and this plugin.

No further steps are needed: the event-stream renderer activates automatically for new conversations, and existing sessions are untouched.

## Configuration

Profile patch ID: `conversation-ui`. Set values in the profile's `cordis.patch.yml` overlay (the suite bundle defaults to `mode: teleprompter`, `preset: balanced`).

| Option | Range | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `teleprompter` \| `typewriter` | `teleprompter` | Reveal style of assistant content. |
| `preset` | `realtime` \| `balanced` \| `silky` | `balanced` | Smoothing cadence preset. |
| `revealCharsPerSec` | 5–200 | `80` | Fixed reveal rate for `typewriter` mode. |
| `scrollSpeedPxPerSec` | 1–200 | `48` | Minimum viewport-follow speed. |
| `maxScrollSpeedPxPerSec` | 1–2000 | `1000` | Follow speed ceiling; prevents teleporting after a large lag. |

Overlay example:

```yaml
- id: conversation-ui
  name: '@jcy2387/dsh-conversation-ui'
  config:
    mode: typewriter
    preset: silky
    revealCharsPerSec: 60
```

User preferences such as *Auto-expand thinking* do not go through the overlay: change them in **Settings → Plugins → Plugin configuration** — they apply immediately and persist across restarts.

### Temporarily disable

The package ships a [`conversation-ui-off.yml`](conversation-ui-off.yml) overlay that disables the plugin (restoring the stock chat renderer) without uninstalling it:

```yaml
- id: conversation-ui
  disabled: true
```

## Architecture

The package ships two halves that cooperate over one very narrow config channel:

- **Host half** (`src/`): a Cordis plugin. It validates the config schema, injects the validated value into every served index HTML (the boot global `window.__DSH_CONVERSATION_UI_CONFIG__`), and registers the user-settings namespace plus a loopback-only settings RPC (read/write preferences, report installation kind, trigger an npm update).
- **Web half** (`src/client/`): React views. It registers at low priority to shadow the `assistant-step` node view with the Codex-style presentation, wraps every other growing chat row (tool cards, retries, workflows…) in place so they share the follow engine, adds the turn-tail deliverables card, and mounts the plugin configuration card in Settings. The stream still renders with defaults when locale, connection, or the settings service is absent.

## Development

```sh
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
```

Tests run on vitest + Testing Library, covering the stream-smoothing hook, follow and folding behavior, and the settings card (both client and host sides). See the [monorepo README](../../README.md) for workspace-wide commands.

## License

[MIT](LICENSE) © jcy2387
