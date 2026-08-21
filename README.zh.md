# @jcy2387/dsh-codex-provider-plugin

[English](README.md) | 中文

一个独立发布、可通过 `dsh plugin add` 安装的 OpenAI Codex Provider。它使用 ChatGPT OAuth 登录，通过 Harness 原生 LLM 服务注册 `openai-codex`，并在 Web 设置页提供浏览器登录和设备代码登录。

本包不修改 `deepseek-harness` 源码，也不把 Codex 当作 subagent。Codex 模型仍使用 Harness 的普通 Agent loop、工具、权限、session、流式输出和自动压缩链路。

> 此插件使用 pi-ai 的 `openai-codex` Provider 访问 ChatGPT Codex 后端，不是 OpenAI Platform API Key 集成。接口行为、模型权限和配额由 OpenAI 控制，可能变化。请仅用于符合账号与适用条款的场景。

## 架构

一个 npm 包同时包含两张运行面：

- **Host：** 注册 `openai-codex` LLM adapter，通过 Harness credential provider 保存 OAuth 状态、读取账号用量，并提供插件自有的 loopback-only Connection RPC。
- **Browser：** 通过 `dsh.client` manifest 加载原生设置页，只接收经过校验且不含敏感信息的认证与用量快照；Token 和账号 ID 都不会进入浏览器。

Harness 当前只提供扁平的 Settings section 列表，Models 页面也没有外部内容 Slot。因此插件保持为紧随**模型**之后的独立 **OpenAI Codex** 页面，不修改 Harness，也不做脆弱的 DOM 注入。

`cordis.patch.yml` 只插入一个由本包拥有的插件行。本包不导入或修改 `@deepseek-ai/dsh-api-remotes`，安装时不需要 Harness 增加静态 Remote 注册。

模型 ID、`contextWindow` 和 `maxTokens` 直接来自 pi-ai 的 Codex catalog。Harness 通过正常的 `ctx.llm.resolveModelInfo()` 路径读取这些字段，因此 session 上下文预算和自动压缩不需要 Provider 专属接线。

## 从 npm 安装

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider-plugin
dsh web
```

## 设置 OpenAI Codex

> 本插件使用 ChatGPT OAuth 登录，不需要 `OPENAI_API_KEY`，也不是 OpenAI Platform API Key 集成。

设置页大致如下：

<p align="center">
  <img src="https://raw.githubusercontent.com/DamonBao/dsh-codex-provider-plugin/main/docs/images/openai-codex-settings.svg" alt="DeepSeek Harness 中的 OpenAI Codex 设置页" width="900">
</p>

1. 执行 `dsh web` 启动 Web UI。
2. 打开**设置 → OpenAI Codex**，点击**连接 Codex**。
3. 选择**浏览器登录**，使用 ChatGPT 账号完成授权；如果 Host 是无头或远程环境，则选择**设备代码登录**。
4. 状态变为**已连接**后，页面会显示 OpenAI 当前返回的用量周期，并每 60 秒刷新一次。接口没有返回的周期不会显示，插件不会硬编码 5 小时限制。
5. 在正常的模型选择器中选择 `openai-codex` 下的模型。安装插件不会自动修改默认模型。

浏览器登录要求浏览器和 dsh Host 在同一台机器上运行。设备代码登录可能需要先在 ChatGPT 安全设置或工作区权限中启用。账号或工作区必须拥有 Codex 访问权限；模型可用性和配额由 OpenAI 控制。用量数据来自 OpenAI 的 ChatGPT 账号接口，可能随其服务变化。

## 升级

插件按 dsh profile 独立安装。将 `web` profile 中的插件升级到最新已发布版本：

```sh
dsh plugin --profile web update @jcy2387/dsh-codex-provider-plugin --latest
```

也可以安装指定版本：

```sh
VERSION="$(npm view @jcy2387/dsh-codex-provider-plugin version)"
dsh plugin --profile web add "@jcy2387/dsh-codex-provider-plugin@$VERSION" --save-exact
```

确认安装版本后重启 `dsh web`，并在浏览器中强制刷新，避免继续使用旧的客户端 bundle：

```sh
dsh plugin --profile web list @jcy2387/dsh-codex-provider-plugin --depth 0
```

如果从 `deepseek-harness` 源码目录运行，请在这些命令前加上 `pnpm`。

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
    transport: sse
    streamIdleTimeoutMs: 300000
    ipv6CallbackBridge: true
    proactiveRefresh: true
    proxyMode: auto
```

- `credentialRef`：Harness credential provider 中保存序列化 OAuth 状态的引用。
- `transport`：`sse`（默认）、`websocket`、`websocket-cached` 或 `auto`。SSE 是可靠性优先的默认值：上游 `auto` 能在 WebSocket 尚未开始输出时回退，但收到部分输出后不能安全重放请求。若更看重连接复用且已确认网络链路稳定，可显式选择 `auto` 或 WebSocket 模式。
- `timeoutMs`：Provider 请求超时。
- `websocketConnectTimeoutMs`：WebSocket 建连超时。
- `streamIdleTimeoutMs`：等待下一段流数据的最大空闲时间。
- `retryPolicy`：Harness LLM 的标准重试配置。
- `ipv6CallbackBridge`：浏览器登录期间，临时把 `[::1]:1455` 桥接到 pi-ai 的 `127.0.0.1:1455` 监听器。默认启用；如果部署已经显式管理 `PI_OAUTH_CALLBACK_HOST`，可以关闭。仅关闭桥接时，IPv4 端口可用性检查仍然生效。
- `proactiveRefresh`：在 access token 过期前几分钟于后台刷新，过期后的第一个请求不必再等一次令牌往返。默认启用；关闭后退化为纯粹的惰性刷新（过期后的首次请求时刷新）。
- `proxyMode`：`auto`（默认）先读取 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，未配置时再读取 macOS 系统代理、Windows 当前用户代理、Linux GNOME GSettings 或 KDE `kioslaverc`；`environment` 只读取环境变量；`off` 不安装插件代理调度器。

## 网络与代理

- **HTTP(S) 代理**：插件会自动把 OpenAI/ChatGPT Host 请求路由到环境代理或受支持的系统代理，OAuth、令牌刷新、用量查询以及 SSE/WebSocket 模型请求使用同一 dispatcher。代理地址及凭据不会通过 RPC 发送到浏览器。
- **Linux**：按“环境变量 → GNOME → KDE”的顺序识别；服务器、容器及其他桌面环境建议设置标准 `HTTP(S)_PROXY`。Linux TUN 与其他平台一样无需额外接线。
- **TUN 模式**：TUN 对 Node 是透明的，不需要额外代理配置；设置页因此显示“系统路由（直连或 TUN）”，不会根据网卡名称做容易误判的猜测。
- **请求范围**：自动代理只接管 `openai.com` 与 `chatgpt.com` 域名，Harness 的其他网络请求仍交给原有 dispatcher；如果 Host 已安装自定义 dispatcher，插件会保留并优先使用它。`localhost`、`127.0.0.1` 和 `[::1]` 始终绕过代理。
- **设置开关**：可在**设置 → OpenAI Codex**中选择**自动识别**、**仅使用环境变量代理**或**关闭显式代理**。Harness 会把选择持久化到 `$DSH_HOME/settings.yaml` 的 `openai-codex` 分节，并覆盖组合层的 `proxyMode` 默认值。保存后页面会明确提示重启 `dsh web`；插件不会在当前进程中热切换 dispatcher。
- **限制**：自动 dispatcher 支持 HTTP/HTTPS 代理，不执行 PAC，也不直接连接 SOCKS。此类代理请启用代理软件的 HTTP 端口并设置 `HTTPS_PROXY`，或使用 TUN。

代理配置在插件启动时读取；修改环境或系统代理后请重启 `dsh web`。

## 令牌刷新

pi-ai 会在双重检查锁内轮换过期的 access token，插件把每次轮换后的凭据写回 Harness 凭据存储。在此之上还有两层行为：

- **主动刷新**：连接状态下，Host 会在 access token 过期前 5 分钟于后台刷新。瞬时的网络失败会在 1 分钟后、然后每 5 分钟重试一次，且不改变登录状态。
- **失败可见**：如果 OpenAI 拒绝了 refresh token（例如 `invalid_grant`），设置页状态会翻转为**登录已失效**并给出重新连接入口，而不是让请求在后台静默失败。之后任何一次刷新成功（定时器或请求路径）都会自动恢复为**已连接**。刷新错误只保留在 Host 日志中，跨 RPC 的只有不含密钥的状态。

## 认证排障

设置页会显示稳定的诊断码，但不会把 OAuth 响应正文或 Token 返回浏览器：

| 诊断码 | 含义与下一步检查 |
| --- | --- |
| `CODEX_AUTH_ACCOUNT_ACCESS` | OpenAI 没有签发可用的 Codex 凭据。检查 MFA、登录时选择的 ChatGPT 工作区和工作区 Codex 权限。 |
| `CODEX_AUTH_BROWSER_CALLBACK` | Host 没有收到有效授权码。确认浏览器和 Host 在同一台机器，登录过程中不要重启 dsh，并检查浏览器是否拦截 `localhost:1455`。 |
| `CODEX_AUTH_BROWSER_CALLBACK_PORT` | Host 无法监听 `localhost:1455`。请停止其他 dsh/Codex 登录或占用该端口的应用后重试。 |
| `CODEX_AUTH_BROWSER_CALLBACK_TIMEOUT` | 十分钟内没有收到回调。请重新发起登录且不要在过程中重启 dsh，或改用设备代码登录。 |
| `CODEX_AUTH_DEVICE_CODE_DISABLED` | 在 ChatGPT 个人安全设置或工作区权限中启用设备代码登录。 |
| `CODEX_AUTH_NETWORK` | 检查 Host 的代理、DNS、TLS 信任和防火墙能否访问 OpenAI 认证服务。 |
| `CODEX_AUTH_TOKEN_EXCHANGE` | 授权已经返回，但凭据交换失败。重试并检查 Host 系统时间和代理。 |
| `CODEX_AUTH_UNSUPPORTED_REGION` | 浏览器授权已完成，但 Host 网络出口位于 OpenAI 不支持的国家或地区。请让 Host 使用符合 OpenAI 服务范围和条款的网络，再发起一次全新登录。 |
| `CODEX_AUTH_UNKNOWN` | 在同一台 Host 上测试官方 Codex 登录，用于区分账号/环境问题与插件兼容问题。 |

浏览器登录会重定向到 `http://localhost:1455/auth/callback`，因此只适合浏览器和 dsh Host 在同一台机器的场景。启动 pi-ai 前，插件会先确认 `127.0.0.1:1455` 可用；如果已被其他进程占用，会立即以 `CODEX_AUTH_BROWSER_CALLBACK_PORT` 失败。浏览器登录进行期间，本插件还会打开一个 IPv6-only 的 `[::1]:1455` 监听器，在 Host 内把原始回调路径和查询参数转发到 IPv4 上的 pi-ai，再把 pi-ai 响应返回浏览器，并在本次登录结束后关闭。这样不会再让浏览器发起第二次跳转，避免被代理、PAC 或 localhost 安全策略截断。它不会监听局域网地址；十分钟内没有回调的浏览器登录会自动结束，不再无限占用登录状态。完整的 provider 异常只保留在 Host 日志中，浏览器只接收上表中的诊断码。无头 Host 应在账号或工作区启用相应权限后使用设备代码登录。参见 [OpenAI Codex 认证文档](https://learn.chatgpt.com/docs/auth)。

## 当前范围

插件包含 Provider、OAuth 生命周期、原生设置 UI、模型目录、压缩使用的上下文元数据和 Codex 用量展示。Host 使用刷新后的 OAuth 凭据请求 `https://chatgpt.com/backend-api/wham/usage`，校验响应后，只通过 loopback-only RPC 返回套餐、用量百分比、重置时间和可选的额度余额。UI 只渲染接口实际返回的周期，因此不会假设存在 5 小时限制。

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
- `lib/client.cjs`：loader-compatible browser 插件，CSS Modules 已内联。
- `lib/types/**`：Host 与 browser declaration files。
- `cordis.patch.yml`：由 `dsh.bundle` manifest 激活的 profile layer。
