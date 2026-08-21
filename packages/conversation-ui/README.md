# @jcy2387/dsh-conversation-ui

DeepSeek Harness 的 Codex 风格对话界面增强插件。它将 Web 对话组织成连续的事件流：过程答复、Think、Tool 活动和最终答复按发生顺序展示，同时保持平滑滚动跟随。

## 功能

- Turn 开始后立即显示处理计时和思考中占位。
- 按 Turn 区分过程区和最终答复，成功完成后自动折叠过程。
- 对 Think、Tool、Retry、Workflow、Compaction、Command 和上下文注入保持自然顺序。
- 为搜索、读取、编辑、命令、数据库、网页、技能、Agent 等 Tool 显示语义图标。
- 支持 `teleprompter`（默认即时快照）和 `typewriter`（按 grapheme 渐进揭示）模式。
- 新内容平滑跟随视口；用户向上阅读时暂时释放跟随，回到底部后恢复。
- 支持 `prefers-reduced-motion` 和低帧率保护。
- 设置页提供持久化的「自动展开思考」开关。

该包与 Codex Provider 独立，对话 UI 可以单独服务其他模型。

## 安装

本地开发版本：

```sh
dsh plugin --profile web add link:/path/to/dsh-codex-suite/packages/conversation-ui
dsh web
```

已发布版本：

```sh
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
dsh web
```

也可以安装 `@jcy2387/dsh-suite`，一次启用 Codex Provider 和本插件。

### 临时禁用

`conversation-ui-off.yml` 是可选的 profile overlay，仅禁用插件，不会移除已安装的包：

```yaml
- id: conversation-ui
  disabled: true
```

## 配置

组合包默认配置为 `mode: teleprompter`、`preset: balanced`。可在 profile 的 `cordis.patch.yml` 中覆盖：

| 配置 | 可选值 / 说明 |
| --- | --- |
| `mode` | `teleprompter` 或 `typewriter` |
| `preset` | `realtime`、`balanced`、`silky` |
| `revealCharsPerSec` | `typewriter` 的揭示速度 |
| `scrollSpeedPxPerSec` | 跟随视口的最低速度 |
| `maxScrollSpeedPxPerSec` | 跟随视口的速度上限 |

在 **设置 → 插件 → 插件配置** 中可修改「自动展开思考」。该设置是用户级持久化偏好，保存后立即生效。

## 开发

```sh
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
```

## 许可证

[MIT](LICENSE)
