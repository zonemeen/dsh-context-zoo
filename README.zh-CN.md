# dsh-context-zoo

[English](README.md) | 简体中文

把 Claude Code、Codex、OpenCode、Pi、Qwen Code、ZCode 和 Kimi Code 的上下文管理流程分别实现为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。TypeScript + pnpm monorepo，每个插件负责计量、触发、历史选择、输入整理、摘要、重试和恢复流程。

`core` 只负责 DSH 服务接入、模型调用、文件读取和会话提交。七个插件没有继承通用压缩算法；原始 agent 的界面、工具运行时和会话文件格式由 DSH 的对应能力承接。

## 七个独立插件

| 插件 | 主要流程 |
| --- | --- |
| [`dsh-context-claude-code`](packages/claude-code/README.zh-CN.md) | usage 锚点、空闲微压缩、全量摘要、整组溢出重试、文件与技能恢复、失败熔断 |
| [`dsh-context-codex`](packages/codex/README.zh-CN.md) | usage 锚点、本地摘要、最近用户文本保留、UTF-8 截断、摘要溢出的成对缩减、退避重试 |
| [`dsh-context-opencode`](packages/opencode/README.zh-CN.md) | 原生预算、可选工具清理、整轮与轮内尾部保留、摘要合并、溢出后的用户消息与附件处理 |
| [`dsh-context-pi`](packages/pi/README.zh-CN.md) | 原生估算与 usage、切点选择、历史和回合前缀双摘要、累计文件清单、分支摘要、临时错误退避 |
| [`dsh-context-qwen-code`](packages/qwen-code/README.zh-CN.md) | 空闲与体积微压缩、截图触发、XML 摘要验证、摘要模型回退、文件和图片恢复、413 特例 |
| [`dsh-context-zcode`](packages/zcode/README.zh-CN.md) | assistant 轮次、按组微压缩、九节摘要、溢出缩减、计划与文件恢复、失败熔断 |
| [`dsh-context-kimi-code`](packages/kimi-code/README.zh-CN.md) | 完整历史摘要、输入预缩减、模型溢出重试、原始用户输入恢复、TODO 和日志恢复信息 |

每包的 `src/pipeline.ts` 是实际流程，`createPipeline()` 可配合独立宿主测试；`strategy` 导出固定来源与预算元数据。`strategy.source.url` 指向源项目，`revision` 和 `license` 描述实际参考的本地版本，包括 fork 和源码还原项目。ZCode 与 Kimi 已核对本地 clone，分别固定在 `29628c9`、`be7d5f5`。

Claude Code 参考的是非官方 2.1.88 还原代码，不能代表官方完整实现。各包 README 明确列出需要原生宿主配合的部分；未提供的缓存接口、REPL 状态或日志路径不会被伪装成已恢复。

Codex 插件实现本地摘要流程。[插件说明](packages/codex/README.zh-CN.md#宿主适配与限制) 列出了需要额外宿主能力的原生 Codex 模式。

## 构建与检查

仓库开发需要 Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`、pnpm `11.9.0`。已发布包支持 Node.js `^22.19.0 || >=24.0.0`。

```sh
pnpm install
pnpm check
```

`check` 构建所有包，运行源流程测试、包结构检查，以及经过真实 Cordis Loader 和 DSH 服务的接入测试，包括 `/compact` 和自动压缩。测试使用可控模型适配器，不需要 API key。`pnpm compare` 比较七个插件的预算元数据，不衡量模型摘要质量。

如果本地已有 DSH 源码，可用仓库自带的 headless 和 Web 配置验证生成的覆盖补丁：

```sh
DSH_SOURCE_DIR=/path/to/deepseek-harness pnpm test:profiles
```

这项可选检查验证配置组合，不包含完整 Web/Electron 启动或外部模型调用。

### DeepSeek 实际 API 检查与凭据

[2026-09-26 实测结果](reports/deepseek/2026-09-26/README.zh-CN.md) 汇集了不同次执行中七个插件的最终观察，包含所选调用的 API 用量、测试范围与限制，以及汇总文件 `results.json`。

通过环境变量向测试进程提供 `DEEPSEEK_API_KEY` 后运行：

```sh
pnpm test:deepseek
```

[测试脚本](scripts/check-deepseek.mjs) 使用 DSH 官方 DeepSeek 适配器、`https://api.deepseek.com/anthropic` 和 `deepseek-flash`。先测压缩前的事实召回，再逐个运行七个插件的 `/compact`，从事件记录恢复会话后再次检查召回。测试使用合成的文本历史，最多发起 18 次 HTTP 请求，并设置 `keepRecentTokens: 256`、`maxSummaryAttempts: 1`，摘要输出上限默认为 `maxSummaryTokens: 2048`。这项检查覆盖手动压缩和召回；默认触发策略、实际上下文溢出和完整应用启动需要单独测试。token 缩减量为估算值，报告另行记录 API 用量。

脚本将 `report.json` 写入临时结果目录，并打印路径。可用 `pnpm test:deepseek --output /absolute/path/to/results` 指定目录。密钥只留在进程内存中，不写入凭据文件或实际 DSH profile。

选择 Codex、将摘要上限设为 4,096 tokens，并跳过最初的未压缩召回基线：

```sh
pnpm test:deepseek --agent codex --max-summary-tokens 4096 --skip-baseline
```

所选插件仍会执行 `/compact` 和会话回放后的召回检查。

在 macOS 上长期保存密钥时，建议通过**钥匙串访问**创建密码项，服务/名称填 `dsh-context-zoo-deepseek`，账户填自己的登录用户名。在 GUI 中输入密钥，仅在启动测试时注入：

```sh
DEEPSEEK_API_KEY="$(security find-generic-password -a "$USER" -s dsh-context-zoo-deepseek -w)" pnpm test:deepseek
```

这样 shell 历史中不会出现密钥原文。钥匙串由 macOS 管理；DSH 原生支持的存储是 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`），它是由 `0600` 权限保护的明文文件，没有加密或钥匙串接入。不要把凭据写入仓库文件；已在聊天中暴露的密钥应当轮换。

## 发布到 npm

八个包使用统一版本，根包保持私有。在工作区干净的 `main` 分支选择以下命令，均会选择版本、更新全部包、检查、提交并打标签：

- `pnpm release`：推送版本，由 GitHub Actions 发布。需先配置仓库的 `NPM_TOKEN` Secret。
- `pnpm release:local`：使用本机 npm 登录凭证发布，版本提交和标签保留在本地。

两种方式都将稳定版发布到 `latest`，预发布版发布到 `next`。首次发布 `0.1.0` 增加 `--no-increment`，预览增加 `--dry-run`。`pnpm release:check` 仅检查压缩包；`pnpm release:publish` 在本地重试当前带标签版本。认证、Git 同步和重试步骤见[发布指南](docs/publishing.zh-CN.md)。

## 接入 DSH

目标版本为 DSH `0.1.7-rc.2`。**该版本需要一个 Session 写入接口补丁**：插件状态和辅助模型调用需要记录为可忽略事件，原接口尚不能写入这个标记。仓库安装自动应用补丁；实际启动 DSH 的宿主也必须应用，步骤见 [Session 补丁说明](patches/README.zh-CN.md)。插件会检查实际 Session 实现，缺失时拒绝写入。

完成宿主补丁后，从本仓库根目录构建并安装一个插件。每个包在 `package.json` 中声明 `dsh.bundle.patch: []`，因此 DSH 将其识别为 bundle，但不会加载默认配置层。生成的显式覆盖补丁会在 profile 现有的压缩作用域内启用插件。

```sh
pnpm build
dsh plugin --profile web add link:./packages/pi
dsh --profile web --dump-config > /tmp/dsh-web.yml
node scripts/create-profile-patch.mjs pi /tmp/dsh-web.yml > /tmp/dsh-web-pi.patch.yml
dsh --profile web --patch /tmp/dsh-web-pi.patch.yml
```

将 agent id 和包路径换成需要的插件，例如 `codex` 和 `./packages/codex`。`link:` 使用当前 checkout 的构建产物，修改源码后需重建。一个 profile 使用一种上下文策略。

生成器读取解析完成的 profile，在各自作用域内替换已启用的压缩引擎，并禁用相应的原生工具结果清理器，同时保留其他配置行和 `!!js` 表达式。根作用域/headless 会在 `context-zoo` 分组内插入 `context-zoo-engine`；Web 则保留各已启用预设的压缩分组内的 `compaction-basic` id。不带压缩功能的预设保持原样，包括自带的 `minimal` 预设。图片外置和输出溢写策略仍独立运行。

生成的覆盖补丁基于导出配置中的已有层。切换策略时，移除旧包、安装新包，再从未叠加上一次临时覆盖补丁的基础 profile 导出并重新生成。需要持久启用时，将生成的补丁条目追加到 profile 的 `cordis.patch.yml` 已有条目之后。切换持久配置时，先移除上一次生成的条目，再导出并生成替代补丁。预设配置发生变化后也需要重新生成：DSH 会替换整个 `config` 对象，所以生成的预设覆盖条目包含完整配置。

文件恢复经过 DSH `fs` 服务，沿用宿主的文件权限；没有文件服务或读取被拒绝时，插件记录原因并跳过该文件。

## 配置

在生成的覆盖补丁中，找到名称为所选插件的各配置行，例如 `dsh-context-pi`，编辑这些行的 `config`。下面仅展示 config 片段：

```yaml
config:
  auto: true
  maxSummaryTokens: 8000
  maxOverflowRetries: 2
```

DSH 替换整个 `config` 对象，需要的设置应写在一起，并保留生成补丁中外围的分组和预设配置。

完整配置见 [core README](packages/core/README.zh-CN.md)，默认值和适用字段见各插件 README。相同字段可以有不同算法语义，例如 Pi 的保留预算允许切开一个回合并额外摘要，而 ZCode 默认保留完整的最后一轮。

`/compact` 调用当前插件自己的手动流程。摘要与恢复信息一起提交；失败、取消、输入改变或结果膨胀时不替换原历史。已完成的微压缩单独保留日志，原始消息仍可从 DSH 会话存储读取。

## 扩展与验证

新增 agent 时添加一个包，实现 `ContextPipeline.run()` 和 `summarizeRange()`，通过 `createContextPlugin({ id, create })` 接入。只有 DSH 的底层操作放进 core；来源特有的流程放在对应包，并为触发条件、调用顺序、恢复结果和失败分支添加测试。

Pi 分支摘要通过公开的 `summarizeBranch()` 接入；外部运行时恢复信息通过 `context-zoo/recovery` 提供。两者的使用方式见 [core README](packages/core/README.zh-CN.md)。

英文文档使用 `README.md`，中文文档使用 `README.zh-CN.md`，两者互相链接，以英文为主；代码注释统一使用英文。

本仓库新代码采用 [MIT](LICENSE)。
