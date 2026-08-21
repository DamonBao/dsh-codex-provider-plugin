# @jcy2387/dsh-conversation-ui

[![CI](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.en.md) | 简体中文

DeepSeek Harness（DSH）的 Codex 风格对话界面增强插件：把 Web 对话重绘为一条有序事件流 —— 过程答复、思考、Tool 活动、重试、工作流与最终答复按发生顺序呈现，同时保持平滑的视口跟随。本包由原 `dsh-light-stream` 改名迁移而来，是 [DSH Codex Suite](../../README.zh.md) Monorepo 的对话 UI 包。

**本包与 Codex Provider 完全独立**，可以单独安装并服务任意模型。

## 功能

### 事件流与 Turn 组织

- **Turn 开始即反馈：** 提交后立刻显示处理计时器和「思考中」占位，不再对着空白等待。
- **过程与结论分离：** 每个 Turn 的过程内容（Think、Tool、重试等）归入独立过程区；最终答复成功落地后过程区**自动折叠**，需要时可手动展开。
- **自然顺序保持：** Think、Tool、Retry、Workflow、Compaction、Command 和上下文注入按真实发生顺序排列，不会被分组打散。

### 语义化 Tool 活动

- 搜索、文件读取、编辑、命令、数据库、网页、技能、Agent 等工具各有专属图标，活动流一眼可扫；工具组可折叠/展开。

### 两种流式揭示模式

| 模式 | 行为 |
| --- | --- |
| `teleprompter`（默认） | 内容即时快照呈现，整段向上平滑滑动，像提词器一样阅读。 |
| `typewriter` | 按字素（grapheme）渐进揭示，对中文、emoji 等宽字符安全。 |

- 三档平滑预设：`realtime`（更跟手）、`balanced`（默认）、`silky`（更绵密）。预设控制揭示节奏曲线：到达速率的 EMA 平滑、缓冲目标、追速上限和停顿后的收尾排空速度，让长回复不会整段砸出、快流不会卡顿。
- `typewriter` 模式另有固定揭示速度 `revealCharsPerSec` 可调。

### 智能视口跟随

- 新内容以限速平滑跟随：最低 `scrollSpeedPxPerSec`、最高 `maxScrollSpeedPxPerSec`（大滞后不瞬移）。
- 用户向上滚动阅读时**自动释放跟随**，回到底部后恢复。
- 尊重 `prefers-reduced-motion`；帧率退化时暂停离屏内容的 DOM 提交（FPS 守卫），保住可见帧的流畅。

### 产物卡片

- 每个完成的 Turn 尾部列出**产物**：生成的文件与站点，附增删行数，产出成果一目了然。

### 插件设置卡片

- 在 **设置 → 插件 → 插件配置** 中提供持久化的「自动展开思考」开关（实时生效，无需重启）。
- 卡片同时显示当前版本与安装形态（npm / 本地开发），npm 安装支持一键更新（更新后需重启）。
- 界面中英文本地化。

## 安装

已发布版本：

```sh
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
dsh web
```

本地开发版本：

```sh
dsh plugin --profile web add link:/path/to/dsh-codex-suite/packages/conversation-ui
dsh web
```

也可以安装 [`@jcy2387/dsh-suite`](../all/README.md) 组合包，一次启用 Codex Provider 与本插件。

安装后无需任何操作：发起新对话即自动启用事件流渲染，历史会话不受影响。

## 配置

Profile patch ID：`conversation-ui`。在 profile 的 `cordis.patch.yml` overlay 中设置（组合包默认值为 `mode: teleprompter`、`preset: balanced`）。

| 选项 | 范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | `teleprompter` \| `typewriter` | `teleprompter` | 助手内容的揭示模式。 |
| `preset` | `realtime` \| `balanced` \| `silky` | `balanced` | 平滑节奏预设。 |
| `revealCharsPerSec` | 5–200 | `80` | `typewriter` 模式的固定揭示速度。 |
| `scrollSpeedPxPerSec` | 1–200 | `48` | 视口跟随的最低速度。 |
| `maxScrollSpeedPxPerSec` | 1–2000 | `1000` | 视口跟随的速度上限。 |

Overlay 示例：

```yaml
- id: conversation-ui
  name: '@jcy2387/dsh-conversation-ui'
  config:
    mode: typewriter
    preset: silky
    revealCharsPerSec: 60
```

「自动展开思考」等用户偏好不走 overlay：在 **设置 → 插件 → 插件配置** 中修改，保存即生效并跨重启持久化。

### 临时禁用

包内自带 [`conversation-ui-off.yml`](conversation-ui-off.yml) overlay，可在不卸载包的情况下禁用插件（回到原生对话渲染）：

```yaml
- id: conversation-ui
  disabled: true
```

## 架构

本包由两半组成，通过一条极窄的配置通道协作：

- **Host 半**（`src/`）：Cordis 插件。负责校验配置 schema，并把校验后的配置注入每个服务出的 index HTML（启动配置全局变量 `window.__DSH_CONVERSATION_UI_CONFIG__`）；同时注册用户设置命名空间与一条仅限 loopback 的设置 RPC（读取/写入偏好、查询安装形态、触发 npm 更新）。
- **Web 半**（`src/client/`）：React 视图。以低优先级注册替换 `assistant-step` 节点视图实现 Codex 风格助手呈现；其余增长的对话行（Tool 卡片、重试、工作流等）原位包装以共享跟随引擎；在 Turn 尾部注册产物卡片；并在设置页挂载插件配置卡片。缺少 locale / connection / 设置服务时仍以默认配置运行流式渲染。

## 开发

```sh
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
```

测试基于 vitest + Testing Library，覆盖流式揭示 hook、跟随与折叠行为、设置卡片（客户端与 Host 两侧）。工作区级命令见 [Monorepo README](../../README.zh.md)。

## 许可证

[MIT](LICENSE) © jcy2387
