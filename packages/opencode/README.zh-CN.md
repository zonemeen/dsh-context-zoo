# OpenCode 上下文策略

[English](README.md) | 简体中文

本包实现 OpenCode 的用量判断、工具输出裁剪、保留区间选择、摘要请求、结果验证和溢出续接流程。DSH 负责读取日志、调用模型和提交替换。

## npm 安装

发布后可用 `dsh plugin --profile web add dsh-context-opencode` 安装。按 [npm 指南](https://github.com/zonemeen/dsh-context-zoo/blob/main/docs/publishing.zh-CN.md#使用已发布的包) 应用宿主 Session 补丁并生成启用配置。仅安装包不会替换当前上下文引擎。

## 默认行为

- 有 provider usage 时使用总用量，或累加输入、输出及缓存用量；无 usage 时，对去除 DSH 身份字段后的消息 JSON 使用字符数除以 4 的估算。
- 模型提供独立输入上限时，从该上限扣除 `reserveTokens`，缺省预留为输出预算与 20,000 的较小值。只有总窗口时扣除输出预算；输出预算缺失时使用 32,000。
- 用量达到阈值时触发。保留预算为可用窗口的 25%，最少 2,000、最多 15,000 tokens。先保留完整近期用户回合；一个回合放不下时寻找能容纳的后缀，并保持工具调用与结果完整。
- 工具输出裁剪默认关闭。开启后向前扫描，经过第二个用户消息才处理旧结果；保护累计前 40,000 tokens 的工具输出及 `skill`。遇到上次摘要或已清理结果时停止。候选输出严格超过 20,000 tokens 才清理，错误结果保留。
- 摘要请求使用单独序列化的对话文本，保留工具名和参数，每段工具输出默认最多 2,000 字符。前次摘要参与合并；章节为 Objective、Important Details、Work State、Next Move、Relevant Files。
- 摘要输出上限默认取当前输出预算与 32,000 的较小值。空白、截断、错误、工具调用及媒体响应被拒绝；失败不会提交摘要替换。
- 溢出时若存在更早的用户历史，将最新用户消息保留在尾部，先压缩之前的历史；成功后把保留用户消息中的媒体转换为附件描述，并附带续接指令。摘要失败时保留原始附件。

`reserveTokens`、`thresholdRatio`、`keepRecentTokens` 可以覆盖预算；比例作用于扣除预留后的窗口。`tailTurns` 限定最多保留的用户回合数，设为 0 时汇总全部选中历史。`maxSummaryTokens`、`summaryToolChars`、`summarizationProvider` 与 `summarizationModel` 控制辅助请求。`maxOverflowRetries` 默认每个请求序列 1 次；`maxConsecutiveFailures` 是可选的失败暂停配置，手动压缩成功后清零。

## 实现范围

可直接使用 `createPipeline(config)` 的 `run(host, trigger)` 和 `summarizeRange(host, entries)`。来源算法、摘要文本和状态记录由本包维护；前次摘要及恢复计数记录在会话日志中。`auto: false` 关闭 DSH 自动钩子，显式调用仍可执行。

OpenCode 的 provider 专用消息编码器和第三方插件钩子依赖其运行时。本包使用 DSH 的消息表示；在两种消息表示的分组不同处，优先保持工具调用与结果完整。媒体续接使用 DSH 用户消息替换记录，原始附件仍留在历史日志中。

DSH 的 system 与 developer 消息保留原位；插件逐段应用 OpenCode 的保留算法，跳过只能选中既有 checkpoint 的段。用量判断仍覆盖完整上下文。摘要合并当前上下文中的全部 checkpoint；只有当前上下文没有 checkpoint 时才回退到插件状态记录，避免恢复会话时使用落后的摘要元数据。

源项目为 [anomalyco/opencode](https://github.com/anomalyco/opencode)；实际参考本地 fork 的提交 `beb99270834db8eb62cf3a369e99234d4d4c2cbd`，源项目采用 MIT 许可证。预算和裁剪行为对应 `packages/opencode/src/session/`；摘要章节来自该实现调用的 `packages/core/src/session/compaction.ts`。摘要指令定义在 `src/strategy.ts` 中。
