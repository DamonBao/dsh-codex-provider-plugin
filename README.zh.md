# @jcy2387/dsh-codex-provider-plugin

[English](README.md) | 中文

一个独立发布、可通过 `dsh plugin add` 安装的 OpenAI Codex Provider。它使用 ChatGPT OAuth 登录，通过 Harness 原生 LLM 服务注册 `openai-codex`，并在 Web 设置页提供浏览器登录和设备代码登录。

本包不修改 `deepseek-harness` 源码，也不把 Codex 当作 subagent。Codex 模型仍使用 Harness 的普通 Agent loop、工具、权限、session、流式输出和自动压缩链路。

> 此插件使用 pi-ai 的 `openai-codex` Provider 访问 ChatGPT Codex 后端，不是 OpenAI Platform API Key 集成。接口行为、模型权限和配额由 OpenAI 控制，可能变化。请仅用于符合账号与适用条款的场景。

## 架构

一个 npm 包同时包含两张运行面：

- **Host：** 注册 `openai-codex` LLM adapter，通过 Harness credential provider 保存 OAuth 状态，并提供插件自有的 loopback-only Connection RPC。
- **Browser：** 通过 `dsh.client` manifest 加载原生设置页，只接收无敏感信息的认证状态；Token 不进入浏览器。

`cordis.patch.yml` 只插入一个由本包拥有的插件行。本包不导入或修改 `@deepseek-ai/dsh-api-remotes`，安装时不需要 Harness 增加静态 Remote 注册。

模型 ID、`contextWindow` 和 `maxTokens` 直接来自 pi-ai 的 Codex catalog。Harness 通过正常的 `ctx.llm.resolveModelInfo()` 路径读取这些字段，因此 session 上下文预算和自动压缩不需要 Provider 专属接线。

## 从 npm 安装

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider-plugin
dsh web
```

## 本地开发安装

```sh
pnpm install
pnpm run check
dsh plugin --profile web add link:/Users/baojie/Documents/Projects/github/dsh-codex-provider-plugin
dsh web
```

如果从 `deepseek-harness` 源码目录运行，将后两条命令加上 `pnpm` 前缀：

```sh
pnpm dsh plugin --profile web add link:/Users/baojie/Documents/Projects/github/dsh-codex-provider-plugin
pnpm dsh web
```

启动后打开**设置 → OpenAI Codex**，选择浏览器登录或设备代码登录。安装只会新增 Provider，不会自动切换默认模型；请在正常的模型选择器中选择 `openai-codex` 下的模型。

## 配置

所有字段均可省略：

```yaml
- id: llm-openai-codex
  config:
    credentialRef: OPENAI_CODEX_OAUTH
    transport: auto
    streamIdleTimeoutMs: 300000
```

- `credentialRef`：Harness credential provider 中保存序列化 OAuth 状态的引用。
- `transport`：`sse`、`websocket`、`websocket-cached` 或 `auto`。
- `timeoutMs`：Provider 请求超时。
- `websocketConnectTimeoutMs`：WebSocket 建连超时。
- `streamIdleTimeoutMs`：等待下一段流数据的最大空闲时间。
- `retryPolicy`：Harness LLM 的标准重试配置。

## MVP 范围

MVP 包含 Provider、OAuth 生命周期、原生设置 UI、模型目录，以及压缩使用的上下文元数据。当前版本暂不读取或展示 Codex 剩余用量；该能力应通过独立、由插件拥有且不含敏感信息的 RPC 接入 ChatGPT usage endpoint。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run publint
```

构建产物：

- `lib/index.js`：Host 插件。
- `lib/client.js`：loader-compatible browser 插件，CSS Modules 已内联。
- `lib/types/**`：Host 与 browser declaration files。
- `cordis.patch.yml`：由 `dsh.bundle` manifest 激活的 profile layer。
