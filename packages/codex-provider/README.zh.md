# @jcy2387/dsh-codex-provider

[![CI](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/DamonBao/dsh-codex-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

把 OpenAI Codex 变成可安装的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）LLM Provider —— 用 ChatGPT 账号登录而非 API Key，并附带原生设置页、用量面板和代理感知网络。[DSH Codex Suite](../../README.zh.md) Monorepo 的 Provider 包。

![DeepSeek Harness 中的 OpenAI Codex 设置页](docs/images/openai-codex-settings.svg)

## 功能

### 双流程 ChatGPT OAuth

- **浏览器登录**打开 ChatGPT 授权页并通过回环回调完成；**设备码登录**覆盖无头或远程机器。
- 登录失败在 Host 侧被归类为**无敏感信息的本地化原因** —— 区域受限、回调端口冲突、回调超时、state 不匹配、令牌交换错误、账号权限、网络问题等 —— 浏览器永远不会看到原始（可能含敏感信息的）错误文本。
- **IPv6 回调桥：** pi-ai 的 OAuth 监听只绑 IPv4。当 `localhost` 优先解析到 `::1` 时，插件会临时监听 IPv6 回环地址，并把回调转发给 pi-ai 在 `1455` 端口的 IPv4 监听，浏览器登录依然可用。

### 主动令牌刷新

- 访问令牌在**过期前约 5 分钟**轮换（`marginMs`，默认 `300_000`）。
- 瞬时刷新失败按 **60 秒、之后每 300 秒**重试（`retryDelaysMs`）。
- **终态**刷新失败（刷新令牌已死：`invalid_grant`、明确的过期/吊销、401/403）会被精确识别 —— 服务器错误（5xx）和限流（429）保持可重试 —— 并呈现为「需要重新连接」状态，而不是在流式中途失败或误伤健康的令牌。

### 用量面板

从 ChatGPT 账号级接口（`chatgpt.com/backend-api/wham/usage`）获取并在设置页渲染：

- 套餐类型与 Credits（余额或「无限」）。
- **主 / 次限额窗口**的用量百分比进度条和本地化重置时间。
- 「已达限额」提示；连接状态下每 60 秒自动刷新，另有手动刷新按钮。

### 代理感知网络

- 自动从**环境变量**（`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`）和**系统设置**（macOS `scutil --proxy`、Windows 注册表、Linux GNOME `gsettings` / KDE）探测代理。
- 通过作用域化的 `undici` dispatcher **仅让 OpenAI 流量**（`openai.com`、`chatgpt.com`）走代理；回环保持直连，其他流量不受影响。
- 显式代理模式：`auto`（自动探测）、`environment`（仅环境变量）、`off`（直连）。当前线路与探测问题会显示在设置页；修改模式需重启 Host 生效。

### 可靠性优先的传输

- 默认传输为 **`sse`** —— 上游 `auto` 只在 WebSocket 流事件开始前才回退 SSE，因此 WebSocket 后期失败会因重放请求而重复部分输出，SSE 默认值规避了这一点。
- **5 分钟流空闲超时**（可配置）约束挂死的响应，又不会掐断慢速思考轮次。
- 可配置的请求超时与重试策略。

### 安全边界

- OAuth 状态持久化在 Harness **凭据存储**（默认引用 `OPENAI_CODEX_OAUTH`）；令牌绝不跨越浏览器 RPC，该 RPC 以**仅限 loopback 的权限**注册。
- 来自 OpenAI 的用量响应先经过校验与脱敏，再进入 UI。

## 安装

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh web
```

本地开发版本：

```sh
dsh plugin --profile web add link:/path/to/dsh-codex-suite/packages/codex-provider
dsh web
```

本插件也支持无头 profile —— Web 客户端半是可选的，账号管理通过 loopback 会话的浏览器完成。

## 快速开始

1. 打开 **设置 → OpenAI Codex**，点击**连接**。
2. 在登录弹窗中选择**浏览器登录**（远程机器可选**设备码登录**），完成 ChatGPT 授权。进度实时可见，随时可取消。
3. 连接成功后，在常规模型选择器中挑选 `openai-codex` 模型即可开始对话。

同一设置页在连接后还会显示用量面板和代理模式控件。账号操作（连接/断开/代理）仅在 Web UI 从 loopback 访问时可用。

## 配置

Profile patch ID：`codex-provider`。在 profile 的 `cordis.patch.yml` overlay 中设置。

| 选项 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `transport` | `sse` \| `websocket` \| `websocket-cached` \| `auto` | `sse` | 见上文「可靠性优先的传输」。 |
| `streamIdleTimeoutMs` | 正整数 | `300000` | 读取单个响应流的最大空闲间隔。 |
| `timeoutMs` | 正整数 | — | 可选的请求整体超时。 |
| `websocketConnectTimeoutMs` | 正整数 | — | 可选的 WebSocket 连接超时。 |
| `retryPolicy` | 重试策略对象 | 内置 | 请求重试行为（与其他 DSH Provider 同一 schema）。 |
| `credentialRef` | 凭据引用 | `OPENAI_CODEX_OAUTH` | 保存序列化 OAuth 状态的 Harness 凭据槽。 |
| `ipv6CallbackBridge` | 布尔 | `true` | 为 IPv6 优先主机转发 OAuth 回环回调。 |
| `proactiveRefresh` | 布尔 | `true` | 在过期前主动刷新访问令牌。 |
| `proxyMode` | `auto` \| `environment` \| `off` | `auto` | 也可在设置页修改；重启后生效。 |

Overlay 示例：

```yaml
- id: codex-provider
  name: '@jcy2387/dsh-codex-provider'
  config:
    transport: sse
    streamIdleTimeoutMs: 300000
    proxyMode: auto
```

## 架构

本包由两半组成：

- **Host 半**（`src/`，从包根导出）—— Cordis 插件，注入 `llm`、`credentials`、`settings`。它掌管 OAuth 生命周期（`CodexAuthService`）、令牌刷新（`CodexTokenRefresher`）、网络管理器、用量服务，并通过 `PiAiAdapter`（底层为 `@earendil-works/pi-ai` 的 `openaiCodexProvider`）注册 Provider。模型目录在加载时校验（上下文窗口 / max tokens 必须可用于上下文预算与压缩）。
- **Web 半**（`src/client/`，打包为 `lib/client.cjs`，经 `dsh.client` manifest 发现）—— 注册进 Web UI 设置页的 React 设置分区，提供中英文界面。

两半之间通过一条**仅限 loopback 权限的 RPC 通道**通信（`status`、`network`、`setProxyMode`、`usage`、`login`、`cancel`、`logout`）。跨越该边界的失败原因是枚举值，而非错误文本。

## 开发

```sh
pnpm --filter @jcy2387/dsh-codex-provider check      # typecheck + test + build + publint
pnpm --filter @jcy2387/dsh-codex-provider typecheck
pnpm --filter @jcy2387/dsh-codex-provider test
pnpm --filter @jcy2387/dsh-codex-provider build
```

十个 vitest 套件覆盖：认证状态机与失败归类、IPv6 回调桥、终态与瞬时刷新失败的区分、代理探测（macOS / Windows / Linux / 环境变量）、用量解析与脱敏、设置卡片控制器和 RPC 契约。

工作区级命令见 [Monorepo README](../../README.zh.md)。

## 许可证

[MIT](LICENSE) © jcy2387
