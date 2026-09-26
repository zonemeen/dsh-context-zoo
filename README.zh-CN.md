# dsh-context-zoo

[English](README.md) | 简体中文

把 Claude Code、Codex、OpenCode、Pi、Qwen Code、ZCode 和 Kimi Code 的上下文管理流程分别实现为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。TypeScript + pnpm monorepo，每个插件独立拥有计量、触发、历史选择、输入整理、摘要、重试和恢复流程。

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

需要 Node.js `^22.19.0 || >=24.0.0`、pnpm `11.9.0`。

```sh
pnpm install
pnpm check
```

`check` 构建所有包，运行源流程测试、真实 Cordis/Session/LLM 接入测试和包结构检查。测试使用可控模型适配器，不需要 API key。`pnpm compare` 比较七个插件的预算元数据，不衡量模型摘要质量。

## 接入 DSH

目标版本为 DSH `0.1.7-rc.2`。**该版本需要一个 Session 写入接口补丁**：插件状态和辅助模型调用需要记录为可忽略事件，原接口尚不能写入这个标记。仓库安装自动应用补丁；实际启动 DSH 的宿主也必须应用，步骤见 [Session 补丁说明](patches/README.zh-CN.md)。插件会检查实际 Session 实现，缺失时拒绝写入。

完成宿主补丁后，从本仓库根目录链接一个插件：

```sh
pnpm build
dsh plugin --profile web add link:./packages/pi
dsh --profile web --dump-config
dsh web
```

`link:` 使用当前 checkout 的构建产物，修改源码后需重建。一个 profile 只安装一个上下文插件；切换时先移除旧包。

每个包的 `cordis.patch.yml` 替换 `compaction-basic` 配置行，并禁用独立的 `tool-result-pruner`。profile 需要包含这些行。文件恢复经过 DSH `fs` 服务，沿用宿主的文件权限；没有文件服务或读取被拒绝时记录原因，不把旧工具输出当成当前文件。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖相应行。DSH 替换整行 `config`，需要的字段应写在一起：

```yaml
- id: compaction-basic
  config:
    auto: true
    maxSummaryTokens: 8000
    maxOverflowRetries: 2
```

完整配置见 [core README](packages/core/README.zh-CN.md)，默认值和适用字段见各插件 README。相同字段可以有不同算法语义，例如 Pi 的保留预算允许切开一个回合并额外摘要，而 ZCode 默认保留完整的最后一轮。

`/compact` 调用当前插件自己的手动流程。摘要与恢复信息一起提交；失败、取消、输入改变或结果膨胀时不替换原历史。已完成的微压缩单独保留日志，原始消息仍可从 DSH 会话存储读取。

## 扩展与验证

新增 agent 时添加一个包，实现 `ContextPipeline.run()` 和 `summarizeRange()`，通过 `createContextPlugin({ id, create })` 接入。只有 DSH 的底层操作放进 core；来源特有的流程放在对应包，并为触发条件、调用顺序、恢复结果和失败分支添加测试。

Pi 分支摘要通过公开的 `summarizeBranch()` 接入；外部运行时恢复信息通过 `context-zoo/recovery` 提供。两者的使用方式见 [core README](packages/core/README.zh-CN.md)。

英文文档使用 `README.md`，中文文档使用 `README.zh-CN.md`，两者互相链接，以英文为主；代码注释统一使用英文。

本仓库新代码采用 [MIT](LICENSE)。
