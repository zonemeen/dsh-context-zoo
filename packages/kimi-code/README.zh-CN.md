# Kimi Code 上下文插件

[English](README.md) | 简体中文

本包独立实现 Kimi Code 的完整历史摘要、超限收缩、原始用户输入恢复及会话续接。默认导出 DSH Cordis 插件；`createPipeline(config)` 可直接接受 `ContextHost`，接入见[根目录说明](../../README.zh-CN.md)。

## 默认流程

- 上下文达到有效窗口的 85%，或剩余空间不足 50,000 tokens 时触发；预留大于等于整个窗口时只用比例。优先使用模型的独立输入上限。一次压缩后，用量未增长时不重复压缩。
- 汇总选中段的完整历史。实际调用的 `fullCompactionService` 使用 `originalHistory.length` 替换历史，再由 `compactionHandoff` 恢复用户输入；未采用 `strategy.ts` 中未被该服务调用的“保留四条消息”选择函数。
- 辅助摘要前为输出预留至多窗口的八分之一，再以剩余窗口的 85% 扣除系统和工具开销；必要时先保留可容纳的近期后缀。
- 摘要最多尝试五次。输入超限后最多按当前摘要历史 tokens 的 70%、50%、35% 收缩，并丢弃开头孤立的工具结果；只缩小辅助输入，原始替换区间保持完整。空白或截断摘要丢弃最旧消息后重试。限流、网络和暂时服务错误按 500ms 指数退避，最大 32 秒，加 25% 随机抖动；取消立即中止。
- 观察到超限时，将该模型的有效容量下调为估算请求 tokens 的 85%。请求体过大错误仅在用量达到窗口一半时尝试上下文恢复；每个失败请求序列默认最多恢复三次，成功模型步骤后重新计数。
- 摘要前恢复真正的用户输入，预算 20,000 tokens。超出时保留最早 2,000 和最新 18,000，中间添加省略提示。按消息 ID 去重，并采用最新持久化表示；之前 checkpoint 中的原始用户输入从日志恢复。合成提示和工具输出不冒充用户输入。
- 摘要后附带观察到的 TODO、会话日志入口和续接提示。实时 TODO 优先，否则从最近一次成功的 TodoWrite/todo_write 恢复。工具调用、媒体或失败的摘要响应被拒绝，不提交替换。

## 配置

`reserveTokens` 和 `thresholdRatio` 覆盖触发预算，`keepRecentTokens` 覆盖原始用户输入恢复预算。`maxSummaryTokens` 覆盖模型输出预算；模型没有输出预算时，采用窗口与 128 Ki tokens 两者中较小值。`summaryToolChars` 默认 0，保留工具输出全文；正数仅裁剪辅助摘要请求中的工具文本。

`maxSummaryAttempts`、`summaryRetryDelayMs` 和 `maxOverflowRetries` 控制重试。`summarizationProvider` 与 `summarizationModel` 须同时设置。`restoreContext: false` 关闭原始用户输入和恢复提醒，TODO 仍参与摘要补充。`auto: false` 关闭 DSH 自动钩子，显式调用仍可执行。此流程不使用工具输出 microcompaction 或近期轮次保留参数。

## 来源和 DSH 映射

参考 [MoonshotAI/kimi-code 固定版本](https://github.com/MoonshotAI/kimi-code/tree/be7d5f5fea7800778e4660cd5f36780ba783bddd)，提交 `be7d5f5fea7800778e4660cd5f36780ba783bddd`，MIT。实际流程对应 `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts`、`agent/contextMemory/compactionHandoff.ts`、`llm-adapter/contract/tokens.ts` 和 `_base/utils/retry.ts`。摘要指令在本项目重新编写。

原服务通过 `tokenCounting.get(agentContext).size` 决定是否触发压缩，本插件对应使用 DSH `measuredTokens`，包括宿主的 usage 校准。辅助摘要缩减和用户恢复使用本包的 ASCII 字符数除以 4、其他 Unicode 码点逐个计数的估算，图片按 2,000 tokens 计。工具名、参数和角色参与估算。

DSH 负责模型传输、附件编码、取消和会话事务。system/developer 消息保留原位；插件选取这些消息之间首个包含待处理历史的段，汇总整段并跳过只有 checkpoint 的段。用户恢复块与摘要共同写入 DSH checkpoint；原始消息仍留在日志。容量观测、失败请求计数和压缩后用量也写入日志。

Kimi 特有的动态工具公告来源字段不在 DSH 消息中，因此不会按猜测删除普通用户文本；DSH 的可调用工具由宿主快照提供。wire/transcript 路径和日志行号只采用宿主提供的真实入口，缺少入口时保留续接提示。

验证：在仓库根目录先运行 `pnpm build`，再运行 `node --test tests/zcode-kimi-pipelines.test.mjs`。
