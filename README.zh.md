# DSH Codex Suite

[![CI](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-green.svg)](#开发)
[![pnpm](https://img.shields.io/badge/pnpm-11-orange.svg)](#开发)

[English](README.md) | 简体中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的插件套件：把 **ChatGPT / OpenAI Codex 模型**和 **Codex 风格的对话体验**带进 DSH Web UI。

本仓库是 pnpm monorepo，包含两个相互独立的运行时插件和一个纯组合包：

| 包 | 类型 | 功能 |
| --- | --- | --- |
| [`@jcy2387/dsh-codex-provider`](packages/codex-provider) | 运行时插件 | 注册 `openai-codex` Provider：ChatGPT OAuth 登录、主动令牌刷新、用量面板、代理感知网络和原生设置页。 |
| [`@jcy2387/dsh-conversation-ui`](packages/conversation-ui) | 运行时插件 | 将 Web 对话重绘为 Codex 风格事件流：Turn 折叠、语义化 Tool 活动、流式揭示、产物卡片和平滑视口跟随。 |
| [`@jcy2387/dsh-suite`](packages/all) | 纯组合包 | 不含运行时代码，仅通过一个 profile patch 一次装齐两个插件。 |

两个插件完全解耦：Conversation UI 可服务任意模型，Codex Provider 也可搭配原生对话界面使用。`@jcy2387/dsh-conversation-ui` 由原 `dsh-light-stream` 改名迁移而来。

---

## 为什么需要这套件

**Codex Provider —— 无需 API Key 的可靠 ChatGPT 接入**

- **双流程 ChatGPT OAuth。** 浏览器登录 + 设备码兜底。登录失败会被归类为无敏感信息的本地化原因（区域受限、回调端口冲突、令牌交换错误、网络问题……），而不是裸报错堆栈。
- **IPv6 回环回调桥。** pi-ai 的 OAuth 监听只绑 IPv4；在 IPv6 优先的主机上，套件会透明转发回环回调，登录依然可用。
- **主动令牌刷新。** 访问令牌在过期前约 5 分钟轮换，失败按退避重试；刷新令牌失效会被精确识别并提示「需要重新连接」，而不是在流式中途崩掉。
- **用量面板。** 从 ChatGPT 账号级接口获取套餐类型、Credits、主/次限额窗口的用量百分比条和重置时间。
- **代理感知网络。** 自动探测环境变量与系统代理（macOS / Windows / Linux），仅让 OpenAI 流量走代理、回环保持直连，并提供显式代理模式（auto / environment / off）。
- **可靠性优先的默认值。** 默认 SSE 传输（避免 WebSocket 后期失败导致部分输出重复）、5 分钟流空闲超时、可配置重试策略。
- **原生设置页** 位于 *设置 → OpenAI Codex*，中英文界面、实时状态，RPC 仅限 loopback 权限——凭据绝不离开 Host。

**Conversation UI —— 像 Codex CLI 一样渲染对话**

- **单一有序事件流。** 过程答复、思考、工具调用、重试、工作流、压缩和命令按自然顺序在各自 Turn 内呈现。
- **Turn 折叠。** Turn 开始即显示计时与思考占位；最终答复落地后过程区自动折叠（可展开，并提供持久化的「自动展开思考」偏好）。
- **语义化工具图标。** 搜索、文件读写、Shell、数据库、网页、技能、Agent 等工具各有专属图标，活动一眼可扫。
- **两种揭示模式。** `teleprompter`（默认）：即时快照向上平滑滑动；`typewriter`：按字素渐进揭示。三档平滑预设（`realtime` / `balanced` / `silky`）调节节奏。
- **智能视口跟随。** 新内容在限速范围内平滑跟随；用户上滑阅读即释放跟随，回到底部自动恢复。尊重 `prefers-reduced-motion`，低帧率下优雅降级。
- **产物卡片。** 每个完成的 Turn 列出生成的文件与站点，并附带增删行数。

---

## 安装

前置条件：装有 `web` profile 的 DeepSeek Harness（`dsh`）、Node.js `^22.19 || >=24`、pnpm 11。

**安装整套 Suite（推荐）：**

```sh
dsh plugin --profile web add @jcy2387/dsh-suite
dsh web
```

**或单独安装插件：**

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
dsh web
```

**本地开发** —— 用工作区内的包替代发布版：

```sh
dsh plugin --profile web add link:$PWD/packages/codex-provider
dsh plugin --profile web add link:$PWD/packages/conversation-ui
dsh web
```

Suite 组合包是幂等的：若某插件已被直接安装，Suite 内的对应副本会自动让位，不会产生重复的加载项。

## 快速开始

1. 安装套件（见上）并打开 Web UI（`dsh web`）。
2. 进入 **设置 → OpenAI Codex**，点击**连接**，选择**浏览器登录**（无头/远程机器可用**设备码登录**），完成 ChatGPT 授权。
3. 回到对话，在模型选择器中挑选 `openai-codex` 模型即可开聊。
4. 可选：在同一设置页查看用量面板，并在 **设置 → 插件 → 插件配置** 中调节对话流参数。

## 配置

两个插件都通过 profile 的 `cordis.patch.yml` overlay 配置；用户级偏好保存在设置界面并跨重启持久化。

**Codex Provider**（profile patch ID：`codex-provider`）

| 选项 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `transport` | `sse` \| `websocket` \| `websocket-cached` \| `auto` | `sse` | SSE 可避免流后期失败时部分输出被重复。 |
| `streamIdleTimeoutMs` | 正整数 | `300000` | 读取单个响应流的最大空闲间隔。 |
| `timeoutMs` / `websocketConnectTimeoutMs` | 正整数 | — | 可选的请求级超时。 |
| `retryPolicy` | 重试策略对象 | 内置 | 请求重试行为。 |
| `credentialRef` | 凭据引用 | `OPENAI_CODEX_OAUTH` | 保存 OAuth 状态的 Harness 凭据槽。 |
| `ipv6CallbackBridge` | 布尔 | `true` | 为 IPv6 主机转发 OAuth 回环回调。 |
| `proactiveRefresh` | 布尔 | `true` | 在过期前主动刷新令牌。 |
| `proxyMode` | `auto` \| `environment` \| `off` | `auto` | 重启后生效；也可在设置页修改。 |

**Conversation UI**（profile patch ID：`conversation-ui`）

| 选项 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | `teleprompter` \| `typewriter` | `teleprompter` | 助手内容的揭示风格。 |
| `preset` | `realtime` \| `balanced` \| `silky` | `balanced` | 平滑节奏档位。 |
| `revealCharsPerSec` | 5–200 | `80` | 打字机揭示速度。 |
| `scrollSpeedPxPerSec` | 1–200 | `48` | 视口跟随最低速度。 |
| `maxScrollSpeedPxPerSec` | 1–2000 | `1000` | 跟随速度上限；防止大滞后后瞬移。 |

若想临时禁用 Conversation UI 而不卸载，应用包内自带的 [`conversation-ui-off.yml`](packages/conversation-ui/conversation-ui-off.yml) overlay：

```yaml
- id: conversation-ui
  disabled: true
```

### 设置入口

| 位置 | 可控内容 |
| --- | --- |
| 设置 → OpenAI Codex | 连接/断开账号、登录方式、用量面板、代理模式。 |
| 设置 → 插件 → 插件配置 | 自动展开思考（实时生效）、插件版本、npm 安装一键更新。 |

## 架构

每个运行时插件都由两半组成：

- **Host 半**（Node）—— Cordis 插件：Provider 注册、OAuth 生命周期、网络与设置持久化，从包根加载。
- **Web 半**（浏览器）—— 通过 `dsh.client` manifest 发现的 React 视图。Codex Provider 提供设置分区；Conversation UI 替换助手节点视图并包装工具行。

两半之间只通过两条窄通道通信：注入到 HTML 的**启动配置全局变量**（`window.__DSH_CONVERSATION_UI_CONFIG__`）把校验后的插件配置带给浏览器；**loopback 权限 RPC** 把设置读写带回 Host。机密信息（令牌、代理地址）绝不跨越 RPC 边界。

各包详细文档：[codex-provider](packages/codex-provider/README.zh.md) · [conversation-ui](packages/conversation-ui/README.md) · [suite](packages/all/README.md)

## 开发

要求：Node.js `^22.19.0 || >=24.0.0`，pnpm `11.7`。

```sh
pnpm install
pnpm run check        # typecheck + test + build + pack dry-run，与 CI 一致
```

单包命令：

```sh
pnpm --filter @jcy2387/dsh-codex-provider check      # typecheck + test + build + publint
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
pnpm --dir packages/all pack --dry-run
```

测试基于 [vitest](https://vitest.dev)，共 13 个套件，覆盖 OAuth 状态机、令牌刷新、网络/代理探测、用量解析、设置控制器和流式客户端视图。CI 还会在固定版本上检出 DSH 源码树供测试解析，校验发布 tag 与三个包版本一致，并审计发布 tarball 的内容。

### 仓库结构

```text
.
├─ packages/
│  ├─ codex-provider/     # @jcy2387/dsh-codex-provider
│  │  ├─ src/             # Host 半：OAuth、刷新、网络、用量、LLM 适配器
│  │  ├─ src/client/      # Web 半：设置分区 UI
│  │  ├─ tests/           # 10 个 vitest 套件
│  │  └─ cordis.patch.yml
│  ├─ conversation-ui/    # @jcy2387/dsh-conversation-ui
│  │  ├─ src/             # Host 半：配置桥、设置 RPC
│  │  ├─ src/client/      # Web 半：流式视图、卡片、跟随引擎
│  │  ├─ tests/           # 3 个 vitest 套件
│  │  └─ cordis.patch.yml
│  └─ all/                # @jcy2387/dsh-suite（纯组合包，无运行时代码）
├─ .github/workflows/ci.yml
├─ pnpm-workspace.yaml
└─ README.md / README.zh.md
```

## 故障排查

- **浏览器登录迟迟不完成** —— 回调桥监听 `127.0.0.1:1455`；请确认端口空闲且浏览器可达回环地址。设置页会给出具体失败类别（端口冲突、超时、state 不匹配……）。
- **区域不受支持** —— OpenAI 拒绝受限区域登录；设置页会以独立原因提示。可通过代理模式（`proxyMode`）改变出口线路（需重启生效）。
- **一段时间后提示「需要重新连接」** —— 刷新令牌已过期或被吊销（如改密）。在设置页重新连接一次即可。

## 许可证

[MIT](LICENSE) © jcy2387
