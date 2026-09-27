# dsh-context-codex

[English](README.md) | 简体中文

本包将 Codex 的本地摘要流程适配为 DeepSeek Harness 插件，独立负责 token 计量、压力检查、摘要请求、历史缩减、重试和最近用户文本保留。默认导出 DSH Cordis 插件；`createPipeline(config)` 提供独立流程，`strategy` 导出预算和来源信息。

## npm 安装

发布后可用 `dsh plugin --profile web add dsh-context-codex` 安装。按 [npm 指南](https://github.com/zonemeen/dsh-context-zoo/blob/main/docs/publishing.zh-CN.md#使用已发布的包) 应用宿主 Session 补丁并生成启用配置。仅安装包不会替换当前上下文引擎。

## 源码安装

使用 DSH `0.1.7-rc.2`，并将 [Session 写入补丁](https://github.com/zonemeen/dsh-context-zoo/blob/main/patches/README.zh-CN.md) 应用到实际宿主。按照根目录的 [安装与启用说明](https://github.com/zonemeen/dsh-context-zoo/blob/main/README.zh-CN.md#接入-dsh) 操作，包路径使用 `./packages/codex`，覆盖补丁生成器的 agent id 使用 `codex`。

本包在 `package.json` 中声明 `dsh.bundle.patch: []`，因此 DSH 将其识别为 bundle，但不会加载默认配置层。安装后通过生成的覆盖补丁启用 Codex。生成器会将插件放到 profile 已启用的压缩作用域中，并禁用相应的原生工具结果清理器。每个 profile 使用一种上下文策略，修改源码后重新构建本仓库。持久启用和策略切换步骤见根目录说明。

```ts
import codexContext from 'dsh-context-codex';

ctx.plugin(codexContext);
```

## 流程

1. 按模型可见内容的 UTF-8 字节数逐条估算消息，约每四字节一个 token。明文 reasoning 不增加估算值，图片使用固定估算值，不按 data URL 长度计量。使用当前检查点之后最近一次有效 assistant usage 作为锚点，加上其后新增消息的估算值；缓存用量只计算一次。
2. 默认在上下文窗口的 90% 触发自动压缩，不从阈值中扣除输出 token 上限。手动压缩绕过压力检查；普通模型请求的上下文溢出和 HTTP 413 由宿主处理。
3. 选择一段已完成的连续历史，保留 system/developer 消息和未完成的工具调用；将选定历史连同当前的 system/developer 消息发送给本地摘要流程，使用 `src/pipeline.ts` 中定义的摘要指令。模型调用和结果记录到 DSH 会话。
4. 摘要请求超出上下文窗口时，移除最旧输入条目及其配对的工具调用或工具结果，再以缩减后的输入重试。每次缩减都会重置普通错误的重试计数。普通模型调用错误默认最多重试五次，采用带随机抖动的指数退避；取消操作会停止流程。
5. 默认在 20000-token 预算内保留最近的真实用户文本，排除上下文注入。最旧一条待保留文本超过剩余预算时，在有效 UTF-8 边界保留首尾并插入截断标记；标记本身的长度不计入文本预算。只保留用户文本，不重新附加图片。已识别的指令、目录、快照、技能、计划和 agent 上下文单独保留，不占用户文本预算。source kind 和 form 相同的快照、目录与计划保留最新版本；不同来源的指令和技能分别保留。
6. 将保留的用户文本与摘要一起提交为 DSH 检查点。摘要失败、取消、为空、被截断或结果膨胀时保留所选历史；包含工具调用或媒体的摘要也会被拒绝。摘要过程中输入发生变化时，DSH 同样拒绝提交。普通压缩和指定范围压缩保留的用户文本在重新加载会话后仍可恢复。

## 配置

在生成的覆盖补丁中找到各个 `dsh-context-codex` 配置行，编辑其 `config`。这些行位于对应分组或预设内部，id 取决于作用域。DSH 替换整个 config 对象，需要的设置应放在一起。下面展示 config 片段：

```yaml
config:
  auto: true
  thresholdRatio: 0.9
  keepRecentTokens: 20000
  maxSummaryAttempts: 6
  summaryRetryDelayMs: 200
  restoreContext: true
```

| 设置 | 默认值与行为 |
| --- | --- |
| `auto` | `true`；启用压力触发的自动压缩 |
| `thresholdRatio` | `0.9`；调低可提前触发，大于 `0.9` 时仍以 `0.9` 为上限 |
| `reserveTokens` | `0`；将触发阈值限制在 `contextWindow - reserveTokens` 以内 |
| `keepRecentTokens` | `20000`；保留真实用户文本的预算 |
| `maxSummaryTokens` | 当前模型路由的输出 token 上限 |
| `maxSummaryAttempts` | `6`；首次请求加最多五次普通错误重试，每次缩减输入后重置 |
| `summaryRetryDelayMs` | `200`；指数退避的初始延迟，上下浮动 10%，最多等待 60 秒 |
| `restoreContext` | `true`；保留 DSH 已记录且已识别的注入上下文 |
| `summarizationProvider`、`summarizationModel` | 当前模型路由；使用独立摘要模型时需同时设置 |

本流程不执行工具结果清理，`prune`、`summaryToolChars`、`maxOverflowRetries` 和 `maxConsecutiveFailures` 在本插件中不生效。摘要输入持续缩减，直到没有可移除的条目；这个过程不消耗普通错误重试预算。

## 宿主适配与限制

DSH 保留自身的 system/developer 消息和未完成的工具调用。保留的用户文本写入检查点内容块，原生 Codex 则重建独立的 user 角色条目。Codex 的初始上下文重新注入依赖其 world state 和回合上下文；本插件使用 DSH 已记录的消息，无法生成缺失的原生状态。

本插件不支持以下原生 Codex 模式：

- 使用原生 `CompactionTrigger` 和不透明 `Compaction` 响应条目的远程 V2 压缩。
- 重新构建 Codex 初始上下文和 world state 的 token-budget 重置。
- 在回合开始前使用上一个模型压缩并重新注入原生上下文。
- assistant 输出完成后的可选压缩调度，需要对应的 DSH 生命周期钩子；该功能在上游默认关闭。

DSH 消息格式不能表示加密 reasoning 和不透明的原生响应条目。文件块与已外置图片按序列化后的附件元数据估算，可能与 provider 实际发送的内容不同。无法按图片原始细节级别计量；内联图片使用固定的默认估算值。原生 compact hooks、模型兼容性哈希、provider 传输重试，以及排除上下文前缀后的正文 token 计量，也不在本插件的实现范围内。本插件在这些宿主能力范围内实现本地摘要流程，不包含当前 Codex 的所有压缩模式。

## 来源

源项目为 [openai/codex](https://github.com/openai/codex)，实际参考版本为 [`e72da2b53805894878023d01949a25a082e0a5cb`](https://github.com/openai/codex/tree/e72da2b53805894878023d01949a25a082e0a5cb)，采用 [Apache-2.0](https://github.com/openai/codex/blob/e72da2b53805894878023d01949a25a082e0a5cb/LICENSE) 许可证。参考文件包括 `codex-rs/core/src/compact.rs`、`codex-rs/core/src/context_manager/history.rs` 和 `codex-rs/utils/output-truncation/src/lib.rs`。
