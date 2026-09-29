# 编码续接评测

Task: `invoice-import-v2`; model: `deepseek-flash`; started: 2026-09-29T07:53:54.332Z.

八个插件使用相同任务和评分。每轮的不同预算模式共享一个基线，以下保留每次实际运行的结果。

开发阶段：10；压缩边界：阶段 3、6、9 后。完整通过需要最终代码验收通过、每阶段修改代码并运行开发测试、提交三次摘要、完成三次磁盘重载，并在第三次摘要后继续修改代码。

保护性跳过或摘要被拒绝后继续任务，但不计作成功压缩。“—”表示未进入最终阶段。每个模式使用新项目，基线在各表中重复展示以便比较。

## fixed

| 插件 / 轮次 | 任务验收 | 任务状态 | 成功摘要 | 磁盘重载 | 完整协议 |
| --- | --- | --- | --- | --- | --- |
| Baseline / 1 | 43/43 | 通过 | 0/0 | 3/3 | 通过 |
| Claude Code / 1 | 43/43 | 通过 | 2/3 | 3/3 | 压缩次数不足 |
| Codex / 1 | 43/43 | 通过 | 2/3 | 3/3 | 压缩次数不足 |
| OpenCode / 1 | 43/43 | 通过 | 2/3 | 3/3 | 压缩次数不足 |
| Pi / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |
| Qwen Code / 1 | 37/43 | 失败 | 2/3 | 3/3 | 任务失败 |
| ZCode / 1 | — | 未完成 | 0/3 | 0/3 | 运行异常 |
| Kimi Code / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |
| Cline / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |

## plugin-defaults

| 插件 / 轮次 | 任务验收 | 任务状态 | 成功摘要 | 磁盘重载 | 完整协议 |
| --- | --- | --- | --- | --- | --- |
| Baseline / 1 | 43/43 | 通过 | 0/0 | 3/3 | 通过 |
| Claude Code / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |
| Codex / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |
| OpenCode / 1 | 43/43 | 通过 | 1/3 | 3/3 | 压缩次数不足 |
| Pi / 1 | 43/43 | 通过 | 0/3 | 3/3 | 压缩次数不足 |
| Qwen Code / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |
| ZCode / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |
| Kimi Code / 1 | 43/43 | 通过 | 3/3 | 3/3 | 通过 |
| Cline / 1 | 43/43 | 通过 | 2/3 | 3/3 | 压缩次数不足 |

## 跳过与异常

| 模式 / 插件 / 轮次 | 阶段后 | 分类 | 原因 |
| --- | --- | --- | --- |
| fixed / Claude Code / 1 | 3 | skipped-short-history | Estimated context 3756 is below minimum 4096. |
| fixed / Codex / 1 | 3 | skipped-short-history | Estimated context 3924 is below minimum 4096. |
| fixed / OpenCode / 1 | 3 | skipped-short-history | Estimated context 4079 is below minimum 4096. |
| fixed / Qwen Code / 1 | 9 | summary-truncated | Summary response stopped at its output limit |
| plugin-defaults / OpenCode / 1 | 6 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / OpenCode / 1 | 9 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / Pi / 1 | 3 | skipped-short-history | Estimated context 3679 is below minimum 4096. |
| plugin-defaults / Pi / 1 | 6 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / Pi / 1 | 9 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / Cline / 1 | 3 | skipped-short-history | Estimated context 4049 is below minimum 4096. |

- fixed / Qwen Code / 1: retry-example, retry-all-statuses-and-attempts, refresh-example, refresh-restarts-retention, retry-hint-example, retry-hint-bounds-and-fallback

- fixed / ZCode / 1: Stage model-step budget exhausted.

## 用量

| 模式 / 插件 / 轮次 | 任务调用 | 摘要调用 | 摘要请求上限 | 输入 | 缓存输入 | 输出 | 重复读取 | 耗时（秒） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shared / Baseline / 1 | 32 | 0 | — | 7082 | 174592 | 8780 | 0 | 49.293 |
| fixed / Claude Code / 1 | 35 | 2 | 4096 | 31896 | 156544 | 13767 | 9 | 67.039 |
| fixed / Codex / 1 | 38 | 2 | 4096 | 30161 | 153216 | 12526 | 3 | 66.003 |
| fixed / OpenCode / 1 | 37 | 2 | 4096 | 26596 | 136704 | 11397 | 3 | 58.989 |
| fixed / Pi / 1 | 46 | 6 | 4096 | 41353 | 195968 | 17162 | 4 | 86.692 |
| fixed / Qwen Code / 1 | 56 | 3 | 4096 | 56295 | 480256 | 25610 | 12 | 127.511 |
| fixed / ZCode / 1 | 12 | 0 | — | 2328 | 23552 | 1740 | 0 | 12.162 |
| fixed / Kimi Code / 1 | 44 | 3 | 4096 | 20078 | 202752 | 15923 | 10 | 84.360 |
| fixed / Cline / 1 | 42 | 3 | 4096 | 32368 | 156800 | 14167 | 0 | 72.842 |
| plugin-defaults / Claude Code / 1 | 43 | 3 | 8192 | 44395 | 212608 | 17193 | 11 | 83.445 |
| plugin-defaults / Codex / 1 | 38 | 3 | 8192 | 35852 | 146304 | 14990 | 7 | 75.496 |
| plugin-defaults / OpenCode / 1 | 37 | 1 | 8192 | 12129 | 182784 | 11699 | 1 | 63.399 |
| plugin-defaults / Pi / 1 | 34 | 0 | — | 6809 | 179200 | 8259 | 0 | 49.871 |
| plugin-defaults / Qwen Code / 1 | 39 | 3 | 8192 | 46144 | 193152 | 20423 | 9 | 91.257 |
| plugin-defaults / ZCode / 1 | 45 | 3 | 8192 | 27332 | 276352 | 23938 | 4 | 107.925 |
| plugin-defaults / Kimi Code / 1 | 42 | 3 | 8192 | 19437 | 186880 | 13842 | 10 | 76.446 |
| plugin-defaults / Cline / 1 | 35 | 2 | 8192 | 25482 | 157440 | 11817 | 1 | 69.626 |

HTTP 请求：694；响应：{"200":694}。缺失用量的调用数：0。总耗时：1242.415 秒。输入列为未缓存输入；统计包含摘要和重复读取。

## 配置与证据

固定摘要上限：4096；模型路由上限：8192；任务调用上限：4096；压缩边界的最低上下文估算：4096。固定模式使用一次摘要尝试及 256-token 最近历史预算（Claude/Qwen 为 0）。插件默认模式只传入 auto:false，在统一模型路由上限内使用各插件默认的历史保留和重试行为。每次运行均记录实际设置和请求上限。

手动检查点不衡量自动触发策略或真正填满上下文的行为。每个模式单次运行无法给策略排名，也无法证明缺陷由压缩造成。不同任务版本和预算模式应分别比较。

- [report.json](report.json)
- [final-sources.json](final-sources.json)

JSON 报告记录各阶段验收、压缩原因和持久化失败事件、token 估算、源文件哈希、API 调用和重载结果。本地运行目录保留代码和会话快照。早先报告另行保留。
