# @dsh-context-zoo/core

[English](README.md) | 简体中文

独立上下文插件的 DSH 接入层。core 提供会话观察、模型调用、受宿主权限约束的文件读取和提交事务，不选择压缩阈值、历史范围、提示词、重试次数或恢复内容。

DSH peer dependencies 固定为 `0.1.7-rc.2`，Cordis 为 `~4.0.4`。使用前须按仓库的 [Session 补丁说明](../../patches/README.zh-CN.md) 处理实际宿主依赖。

## 接口

```ts
import { createContextPlugin } from '@dsh-context-zoo/core';
import { createPipeline } from './pipeline.js';

export default createContextPlugin({ id: 'my-agent', create: createPipeline });
```

`ContextPipeline` 的 `run(host, trigger)` 拥有一次完整执行流程。触发原因是 `pressure`、`manual`、`context-overflow` 或 `request-too-large`；显式范围压缩调用 `summarizeRange()`。每个会话有自己的 pipeline 实例，需恢复的状态通过 `host.record()` 和 `host.records()` 存取。

`ContextHost` 提供：

| 方法 | 行为 |
| --- | --- |
| `snapshot()` | 当前消息、完整消息归档、usage、路由、窗口、工具、时间与会话标识 |
| `summarize()` | 按插件给出的消息和指令调用模型，记录实际输入、输出、finish 和错误 |
| `replace()` | 把插件选中的 user/tool 内容写成可回放的替换；保留角色、标识和来源 |
| `compact()` | 对选定连续范围加锁，运行摘要与恢复，校验后提交检查点 |
| `readFile()` | 经 DSH `fs` 流式读取指定字符数；不可用时返回 null 并记录原因 |
| `record()` / `records()` | 追加与读取带插件命名空间的持久状态 |

`Checkpoint` 可包含 `beforeSummary`、`summary` 和 `restored`。三部分在一个检查点中提交。原生角色结构不同的恢复内容需要插件做明确适配；这个接口不会创建其他 agent 的会话树或工具缓存。

## 提交和恢复

core 校验工具调用配对、连续范围、并发压缩锁和摘要后的历史稳定性。自动压缩要求整个当前历史保持一致；手动压缩允许范围外追加上下文。替换后的总内容必须小于被替换范围；系统和开发者消息不参与替换。遇到历史中途的系统或开发者更新，各插件分别在连续会话段上运行自己的选择算法，跳过已经压缩或无法继续缩减的段，保留这些更新的位置。

辅助调用单独记录，所以 Pi 的两次摘要、失败重试和模型回退都可追查。`compaction/summary` 只在恰好一次模型调用时写入单调用标记。`compaction/summary` 和对应 `user/message` 保持相邻；原始记录仍在日志中。

手动流程在 DSH maintenance 锁内执行，并等待会话 flush。取消信号传入模型与文件服务；取消后不提交检查点。模型溢出仅在插件造成实际历史替换且未取消时请求重试，次数和失败计数由插件决定。

## 配置

配置在加载时验证。以下字段属于统一配置词汇，各插件只使用有对应源流程的字段；默认值见对应包 README。

| 字段 | 用途 |
| --- | --- |
| `auto` | 自动事件钩子开关；不禁止显式调用压缩方法 |
| `reserveTokens`, `thresholdRatio`, `keepRecentTokens` | 来源特定的触发与保留预算 |
| `maxSummaryTokens`, `summaryToolChars` | 摘要输出上限、辅助输入的工具文本长度 |
| `summarizationProvider`, `summarizationModel` | 摘要路由；必须一起设置 |
| `maxOverflowRetries`, `maxConsecutiveFailures` | 溢出恢复和连续失败限制 |
| `maxSummaryAttempts`, `summaryRetryDelayMs` | 源流程支持的模型重试次数和延迟 |
| `prune`, `keepRecentTools`, `protectToolTokens`, `minPruneTokens` | 源流程支持的微压缩控制 |
| `idleMinutes`, `toolHighWaterChars`, `toolLowWaterChars` | 空闲与工具输出体积阈值 |
| `tailTurns` | OpenCode 的保留回合数 |
| `screenshotTriggerImages` | Qwen 工具截图触发数；0 关闭 |
| `restoreContext`, `maxRestoredFiles`, `maxFileTokens`, `maxRestoreTokens` | 文件和上下文恢复预算 |
| `maxRestoredImages`, `maxSkillTokens` | 图片与技能恢复预算 |

预算、计数和延迟使用非负安全整数；摘要输出、摘要尝试数与连续失败上限必须大于零。比例属于 `(0, 1]`。值为零的含义由各插件说明。

## 宿主集成

外部运行时可以通过 `context-zoo/recovery` waterfall 返回实际观察到的 `approvedPlanPath`、`transcriptPath`、`wirePath`、`windowLines`、`todos`、`reminders` 或 `replStateCleared`。没有观察时调用 `next()`；只有确实清理了 REPL 才能返回 `replStateCleared: true`。文件路径和日志恢复提示不会由 core 猜测。

Pi 分支导航调用：

```ts
import { summarizeBranch } from '@dsh-context-zoo/core';

const summary = await summarizeBranch(ctx, idleAgent, abandonedBranchSeqs, signal);
```

该函数在 maintenance 锁内调用插件分支流程，记录并 flush 摘要。导航集成负责把返回文本写入目标分支的模型可见消息；没有分支流程的插件返回 `undefined`。

`ContextStrategy` 和 `budget()` 是预算比较所需的元数据，实际流程由 `ContextPipeline` 执行。core 不再导出公共历史选择器或工具裁剪算法。
