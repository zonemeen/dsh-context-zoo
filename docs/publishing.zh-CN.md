# 发布到 npm

[English](publishing.md) | 简体中文

在仓库根目录执行维护命令，需要 Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` 和 pnpm `11.9.0`。根包保持私有，以下八个公开包使用统一版本号：

- `dsh-context-core`
- `dsh-context-claude-code`
- `dsh-context-codex`
- `dsh-context-opencode`
- `dsh-context-pi`
- `dsh-context-qwen-code`
- `dsh-context-zcode`
- `dsh-context-kimi-code`

这些无 scope 包名不需要 npm 组织。你的 npm 账号仍需有权发布每个包名；首次发布前，包名的可用状态可能变化。已发布包的 Node.js 要求仍为 `^22.19.0 || >=24.0.0`。

## 选择发布方式

| 命令 | 行为 |
| --- | --- |
| `pnpm release` | 选择版本、检查、提交、打标签并推送，由 GitHub Actions 发布。 |
| `pnpm release:local` | 选择版本、检查、提交并打标签，从本机发布，Git 修改保留在本地。 |
| `pnpm release:publish` | 检查并从本机重新发布当前带标签的版本。 |

两种方式都将稳定版发布到 `latest`，预发布版发布到 `next`。同一版本选择一种发布方式。

## GitHub Actions 配置

1. 创建 npm granular access token，授予包的读写权限、全部八个包名的发布权限，并启用 **Bypass two-factor authentication**，以便无人值守发布。首次发布时，权限必须允许创建新包。参见 [npm CI 认证指南](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/)。
2. 在仓库的 [Settings → Secrets and variables → Actions](https://github.com/zonemeen/dsh-context-zoo/settings/secrets/actions) 中添加名为 **`NPM_TOKEN`** 的 Actions Secret。Token 只保存在 GitHub Secrets 中，不写入仓库文件或命令参数，并在到期前更新。
3. 将发布配置、工作流和包的修改提交并推送到 `main`。本地 `main` 需要跟踪 `origin/main`，Git 凭证需要有提交和标签的推送权限。仓库分支规则也需要允许将发布提交推送到 `main`。

Actions 方式使用本地 Git 凭证和 GitHub 的 `NPM_TOKEN` Secret，本地无需登录 npm。下方的本地发布方式使用本机 npm 登录凭证。两种方式都不需要 DeepSeek API key。

## 检查与预览

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm release --dry-run
```

`release:check` 会构建所有包、运行无需密钥的测试，将八个 npm 压缩包生成到 `.artifacts/npm/`，并检查实际内容。检查项包括统一版本、构建入口、许可证、README、workspace 依赖范围转换，以及打包后的配置生成器。CI 和发布工作流执行相同检查。打包不会发布任何包。

core 压缩包包含 `dsh-context-patch` 和 `dist/compat/` 中的 Session 兼容文件。源码随 source map 一起发布，仓库测试、报告和构建状态文件不进入压缩包。

`--dry-run` 预览所选版本和计划执行的命令，不修改版本、不提交、不创建标签、不推送。它跳过发布检查 hook，因此检查产物时需单独执行 `release:check`。

## 通过 GitHub Actions 发布

在工作区干净、修改已提交且已同步 `origin/main` 的 `main` 分支执行：

```sh
pnpm release
```

在终端选择 patch、minor、major、预发布或自定义版本。选好版本后，命令自动完成：

1. 更新根目录和八个包的版本号，保留 `workspace:^` 引用。
2. 针对所选版本执行 `pnpm release:check`。
3. 创建 `chore: release v<version>` 提交和带注释的 `v<version>` 标签。
4. 通过一次原子推送，将 `main` 和该标签推到 `origin`。任一更新被拒绝时，两者都不会推送。

首次直接发布当前的 `0.1.0`，无需递增版本：

```sh
pnpm release --no-increment
```

该命令仍会检查并创建发布标签；没有文件变化时，无需创建版本提交。也可以直接指定版本，例如 `pnpm release 0.2.0-beta.1`。

## GitHub Actions 发布

推送 `v*` 标签会启动 [Publish npm](../.github/workflows/publish.yml)。任务检查标签与根包版本是否一致、对应提交是否属于 `main`，执行发布检查，将八个已验证压缩包上传为工作流产物，然后按依赖顺序发布：先 core，后七个插件。私有根包会跳过，稳定版本使用 npm 的 `latest` 标签，预发布版本使用 `next`。

只有发布步骤会收到 `NPM_TOKEN`。所有包公开发布到官方 npm registry，pnpm 将 `workspace:^` 转换为对应 core 版本的依赖范围。在仓库的 [Actions 页面](https://github.com/zonemeen/dsh-context-zoo/actions/workflows/publish.yml) 查看结果；本地推送成功表示任务已触发，不代表 npm 发布已经完成。

本地检查失败时不会推送；重试前先检查是否有版本修改残留。原子推送失败时，检查本地发布提交和标签，解决 Git 错误后再推送。`pnpm release` 会拒绝已有标签，不要通过移动已有标签重试发布。Actions 失败或只发布了部分包时，修复 token 过期等外部原因后重新运行该任务：pnpm 会跳过已发布版本，继续发布剩余包。代码或工作流修复需要新版本和新标签。已发布的 npm 版本无法覆盖。

## 从本机发布

先提交发布配置的修改。在跟踪 `origin/main`、工作区干净的 `main` 分支执行，并确保已安装当前依赖。使用有权发布全部八个包名的账号登录官方 npm registry：

```sh
npm login --registry=https://registry.npmjs.org/
pnpm release:local
```

在终端选择版本。命令复用 Actions 方式的版本更新与发布检查，创建本地版本提交和标签，然后使用本机 npm 登录凭证按依赖顺序发布八个包。按 npm 提示完成认证或双因素验证，无需配置 GitHub 的 `NPM_TOKEN` Secret。命令会获取远端 Git 状态用于校验，但不会推送提交或标签。

首次发布 `0.1.0`，或仅预览本地发布流程：

```sh
pnpm release:local --no-increment
pnpm release:local --dry-run
```

需要预览时，在正式发布前运行；预览会跳过实际发布和发布检查 hook。也支持指定版本，例如 `pnpm release:local 0.2.0-beta.1`。

本地 npm 发布失败或只完成部分包时，保留版本提交和标签，解决认证或网络错误后重试：

```sh
pnpm release:publish
```

该命令重新检查并发布当前版本，跳过 npm 上已存在的包版本。它要求工作区干净、处于 `main` 分支且 `HEAD` 与对应的 `v<version>` 标签一致，不修改版本或创建 Git 引用。`pnpm release:publish --dry-run` 可检查并预览当前带标签版本的发布，不上传包。不要通过修改已有发布内容来重试；代码变更需要新版本。

本地发布成功后，通过 `git push origin main` 同步版本提交。将发布标签保留在本地即可避免触发 Actions。推送任何 `v*` 标签（包括本地生成的标签）都会启动现有发布工作流；避免同时运行两个发布流程。

## 使用已发布的包

发布后，用户可以按 npm 包名安装插件。实际 DSH 宿主仍需要 [Session 兼容补丁](../patches/README.zh-CN.md)，发布包不会自动应用该宿主补丁。

```sh
dsh plugin --profile web add dsh-context-pi@0.1.0
dsh --profile web --dump-config > /tmp/dsh-web.yml
pnpm --package=dsh-context-core@0.1.0 dlx dsh-context-patch pi /tmp/dsh-web.yml > /tmp/dsh-web-pi.patch.yml
dsh --profile web --patch /tmp/dsh-web-pi.patch.yml
```

插件和 core 使用匹配的已发布版本。将 `pi` 换成需要的 agent id。生成器读取导出的配置并输出覆盖补丁，不修改宿主或 profile。[安装与启用说明](../README.zh-CN.md#接入-dsh) 包含持久化配置和切换插件步骤。

core 包通过 `dsh-context-core/compat/*` 导出兼容文件，也可直接从压缩包获取：

```sh
npm pack dsh-context-core@0.1.0
tar -xzf dsh-context-core-0.1.0.tgz package/dist/compat
```

将补丁应用到实际 DSH 安装前，先阅读 `package/dist/compat/README.zh-CN.md`。
