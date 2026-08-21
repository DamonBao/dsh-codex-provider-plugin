# DSH Codex Suite

DeepSeek Harness 插件 Monorepo，使用 pnpm 统一维护。仓库包含两个独立运行时插件和一个纯组合包。

## 包结构

- `@jcy2387/dsh-codex-provider`：OpenAI Codex OAuth、模型目录、用量、网络设置和原生设置页。
- `@jcy2387/dsh-conversation-ui`：Codex 风格对话展示、流式揭示、Turn 过程折叠、Tool 语义活动、产物和滚动跟随。
- `@jcy2387/dsh-suite`：纯组合包，通过一个 DSH profile patch 同时启用前两个插件。

`@jcy2387/dsh-conversation-ui` 是原 `dsh-light-stream` 功能的改名迁移版本。它不依赖 Codex Provider，可以服务任何模型。

## 安装

可以单独安装：

```sh
dsh plugin --profile web add @jcy2387/dsh-codex-provider
dsh plugin --profile web add @jcy2387/dsh-conversation-ui
```

也可以安装 Suite 组合包：

```sh
dsh plugin --profile web add @jcy2387/dsh-suite
```

本地开发时，将包名替换为 `link:$PWD/packages/<package>` 即可。

## 开发

要求 Node.js 22.19+ 和 pnpm 11。

```sh
pnpm install
pnpm run check
```

单独构建或测试：

```sh
pnpm --filter @jcy2387/dsh-codex-provider check
pnpm --filter @jcy2387/dsh-conversation-ui typecheck
pnpm --filter @jcy2387/dsh-conversation-ui test
pnpm --filter @jcy2387/dsh-conversation-ui build
pnpm --dir packages/all pack --dry-run
```

可选的 `packages/conversation-ui/conversation-ui-off.yml` overlay 可以在不移除包的情况下禁用 Conversation UI 行。

## Profile patch ID

- `codex-provider`
- `conversation-ui`

配置和各包的详细行为请参阅对应包的 README。
