# @jcy2387/dsh-codex-provider

DeepSeek Harness 的 OpenAI Codex OAuth Provider。

本包负责注册 `openai-codex` Provider、管理 ChatGPT OAuth 凭据、提供用量和网络设置，并添加原生的 OpenAI Codex 设置页。它是 `dsh-codex-suite` Monorepo 中的 Provider 包。

## 安装

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh web
```

打开**设置 → OpenAI Codex**连接 ChatGPT 账号，然后在正常的模型选择器中选择 `openai-codex` 模型。

## 开发

```sh
pnpm --filter @jcy2387/dsh-codex-provider check
```
