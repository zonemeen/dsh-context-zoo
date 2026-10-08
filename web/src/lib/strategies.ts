export type Locale = "zh" | "en";
export type StrategyId = "deepseek" | "claude-code" | "codex" | "opencode" | "pi" | "qwen-code" | "zcode" | "kimi-code" | "cline";
export type StrategyText = {
  subtitle: string;
  description: string;
  principle: string;
  retention: string;
  recovery: string;
  caveat: string;
  steps: [string, string, string, string, string];
  details: [string, string, string, string, string];
};
export type Strategy = {
  id: StrategyId;
  name: string;
  mark: string;
  color: string;
  trigger: string;
  pruning: "optional" | "default" | "none";
  source: string;
  revision: string;
  zh: StrategyText;
  en: StrategyText;
};
export const REPO = "https://github.com/zonemeen/dsh-context-zoo";
export const REPORT = `${REPO}/blob/main/reports/continuation/2026-09-29/extended/README.zh-CN.md`;
export const reportUrl = (locale: Locale) => locale === "zh" ? REPORT : REPORT.replace("README.zh-CN.md", "README.md");
const docs = (id: string) => `${REPO}/blob/main/packages/${id}/README.md`;
export const strategies: Strategy[] = [
  {
    id: "deepseek", name: "DeepSeek Harness", mark: "ds", color: "#487ca8", trigger: "min(0.8W, W − O − 65,536)", pruning: "optional",
    source: "https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/README.md", revision: "5badb15",
    zh: {
      subtitle: "原生压缩引擎", description: "先减轻工具输出，再把较早历史收拢为检查点。最近的对话，继续以原文留在上下文中。",
      principle: "会话日志保留完整记录，上下文是它面向模型的投影。压缩改变投影，原始事件仍可回放。",
      retention: "最近 16% × (W − O)", recovery: "日志投影与近期原文",
      caveat: "展示原生 compaction-basic，假设已挂载可选剪枝器。源码版本为 5badb15，晚于 zoo 插件使用的 DSH 0.1.7-rc.2。",
      steps: ["计量上下文", "裁剪工具输出", "选择历史区间", "生成检查点", "提交会话投影"],
      details: ["根据模型路由的窗口、输出上限和 token-meter 估算，计算请求压力。", "可选剪枝器缩短过大的工具文本。如果压力已降到阈值以下，自动流程可以跳过摘要。", "选择较早且工具调用配对完整的区间，保留开头的 system 消息和近期尾部。", "独立请求摘要模型，仅接收文本，并验证摘要比被替换的内容更小。", "记录 start / summary / end，以 user 检查点替换选中区间；原始日志完整保留。"],
    },
    en: {
      subtitle: "Native compaction engine", description: "Trim bulky tool output, condense older history into a checkpoint, and keep recent conversation verbatim.",
      principle: "The session log keeps the full record. Context is its model-facing projection: compaction changes the projection, while original events remain replayable.",
      retention: "Latest 16% × (W − O)", recovery: "Log projection & recent messages",
      caveat: "Shows native compaction-basic with the optional pruner mounted. Source 5badb15 is newer than the DSH 0.1.7-rc.2 host used by the zoo adapters.",
      steps: ["Measure context", "Trim tool output", "Select history", "Create checkpoint", "Commit projection"],
      details: ["Measure pressure using routed model capacity, output reservation, and the token meter.", "The optional pruner shortens oversized tool text. Automatic compaction may skip summarization if pressure is relieved.", "Select an older span with balanced tool pairs. Keep the leading system message and a recent tail.", "Make a separate summary request, accept text only, and require a result smaller than its source.", "Log start / summary / end and replace the span with a user checkpoint. Original events remain in the log."],
    },
  },
  {
    id: "claude-code", name: "Claude Code", mark: "✳", color: "#b17657", trigger: "W − min(O, 20,000) − 13,000", pruning: "optional", source: docs("claude-code"), revision: "2.1.88*",
    zh: {
      subtitle: "摘要与现场恢复", description: "以 usage 锚点追踪用量。汇总历史后恢复文件、技能和计划，让任务从已有状态继续。",
      principle: "摘要保存发生过的事，恢复内容补回继续工作所需的现场。两者一起计入最终检查点。",
      retention: "默认全量，可配置尾部", recovery: "最多 5 个文件、技能与计划",
      caveat: "参考非官方 Claude Code 2.1.88 还原代码，不代表官方完整实现。私有缓存编辑与会话记忆接口未由 DSH 实现。",
      steps: ["锚定 API 用量", "可选微压缩", "选择完整调用组", "生成完整摘要", "恢复工作现场"],
      details: ["从最近 assistant 的输入、缓存、输出 usage 开始，再估算新增消息。", "默认关闭；开启后，空闲 60 分钟可清理旧工具结果，保护最近 5 个与错误结果。", "保护 system、developer 与未完成调用，默认汇总完整可选历史。", "剥离图片和 reasoning；摘要溢出时按完整 API 组缩减输入，最多 4 次请求。", "恢复已观察到的计划、技能与 agent 状态，最多重读 5 个文件。连续 3 次自动失败后暂停。"],
    },
    en: {
      subtitle: "Summary & state restoration", description: "Anchor usage to API measurements, summarize history, then restore files, skills, and plans to continue the task.",
      principle: "The summary preserves what happened. Restored state supplies what comes next. Both count toward the final checkpoint.",
      retention: "Full history by default; optional tail", recovery: "Up to 5 files, skills & plans",
      caveat: "Based on unofficial recovered Claude Code 2.1.88 code, not the complete official implementation. Private cache-edit and session-memory APIs are unavailable in DSH.",
      steps: ["Anchor API usage", "Optional microcompact", "Select complete groups", "Summarize history", "Restore working state"],
      details: ["Start from recent assistant input, cache, and output usage, then estimate new messages.", "Disabled by default. When enabled, 60 minutes idle can trigger cleanup, protecting 5 recent results and errors.", "Protect system/developer messages and open calls; select all eligible history by default.", "Remove images and reasoning. On summary overflow, shrink whole API groups; up to 4 requests.", "Restore observed plans, skills, agent state, and up to 5 files. Pause automatic attempts after 3 consecutive failures."],
    },
  },
  {
    id: "codex", name: "Codex", mark: ">_", color: "#63776d", trigger: "0.9W", pruning: "none", source: docs("codex"), revision: "e72da2b",
    zh: {
      subtitle: "用户意图优先", description: "通过本地摘要缩短历史，同时保留近期用户文本和注入上下文，延续尚未完成的请求。",
      principle: "压缩执行过程时，尽量保留用户真正说过的话。这里展示本地摘要路径。",
      retention: "20k tokens 用户文本预算", recovery: "近期用户文本与注入上下文",
      caveat: "不包含原生 Responses 服务端压缩 V2。20k 是用户文本预算，并非完整对话尾部；普通请求的溢出重试由宿主负责。",
      steps: ["校准用量", "整理摘要输入", "保留用户文本", "本地摘要与重试", "重建检查点"],
      details: ["使用 API usage 锚点与 UTF-8 估算，默认自动阈值为窗口的 90%。", "没有独立的工具剪枝阶段，工具历史由摘要请求处理。", "保留预算内的近期用户文本，截断时保证 UTF-8 安全。", "摘要输入溢出时按完整调用对缩减辅助输入，暂时错误使用退避重试。", "将摘要、保留的用户文本与注入上下文写入 DSH 检查点。"],
    },
    en: {
      subtitle: "User intent first", description: "A local summary reduces history while recent user text and injected context preserve unfinished requests.",
      principle: "As execution history is condensed, preserve the words the user actually wrote. This view covers the local summary path.",
      retention: "20k-token user-text budget", recovery: "Recent user text & injected context",
      caveat: "Excludes native Responses server-side compaction V2. The 20k budget covers user text, not a full conversation tail. Ordinary request overflow belongs to the host.",
      steps: ["Calibrate usage", "Prepare summary input", "Retain user text", "Summarize & retry", "Rebuild checkpoint"],
      details: ["Use an API usage anchor and UTF-8 estimates; trigger at 90% of the window by default.", "There is no separate tool-pruning stage. Tool history is handled by the summary request.", "Keep recent user text within its budget, truncating at safe UTF-8 boundaries.", "On summary overflow, shrink complete call pairs. Back off for transient failures.", "Commit a DSH checkpoint containing the summary, retained user text, and injected context."],
    },
  },
  {
    id: "opencode", name: "OpenCode", mark: "oc", color: "#71727a", trigger: "W − O", pruning: "optional", source: docs("opencode"), revision: "beb9927",
    zh: {
      subtitle: "整轮保留与摘要合并", description: "优先保留完整近期回合，必要时选择配对完整的后缀，并把已有摘要合并进新检查点。",
      principle: "优先以一个完整用户回合作为保留单位，让最近的任务仍能连贯地继续。",
      retention: "可用窗口的 25%，2k–15k", recovery: "近期回合与媒体续接说明",
      caveat: "工具清理默认关闭。参考本地 fork；原生 provider 编码和第三方插件 hooks 依赖 OpenCode 运行时。",
      steps: ["解析原生预算", "可选工具清理", "保留完整回合", "合并旧摘要", "续接用户请求"],
      details: ["有独立输入上限时扣除预留；仅有总窗口时扣除输出预算。", "开启时保护近期 40k tokens 工具输出与 skill，候选超过 20k 才清理。", "默认保留可用窗口的 25%，上限 15k；整轮放不下时寻找完整调用后缀。", "合并当前上下文中的全部检查点，避免恢复后使用过时的摘要状态。", "溢出恢复保留最新用户消息；摘要成功后把其媒体转为附件描述，并补入续接说明。"],
    },
    en: {
      subtitle: "Whole turns & merged summaries", description: "Prefer complete recent turns, fall back to a balanced suffix, and merge existing summaries into the next checkpoint.",
      principle: "A whole user turn is the preferred retention unit, so the latest task can continue coherently.",
      retention: "25% of usable input, 2k–15k", recovery: "Recent turns & media handoff",
      caveat: "Tool pruning is off by default. Based on a local fork; native provider encoding and third-party hooks need the OpenCode runtime.",
      steps: ["Resolve input budget", "Optional tool cleanup", "Keep whole turns", "Merge prior summaries", "Continue the request"],
      details: ["Reserve space from the separate input limit, or subtract the output budget from the total window.", "When enabled, protect 40k recent tool tokens and skill output; prune only if candidates exceed 20k.", "Keep 25% of usable input, capped at 15k. If a turn will not fit, select a balanced suffix.", "Merge all checkpoints in the current context to avoid stale summary state after session recovery.", "On overflow, keep the latest user message. After successful summarization, convert its media into descriptions and add a handoff."],
    },
  },
  {
    id: "pi", name: "Pi", mark: "π", color: "#9270a1", trigger: "W − 16,384", pruning: "none", source: docs("pi"), revision: "8a7b0c0",
    zh: {
      subtitle: "切点与双重摘要", description: "按预算寻找安全切点。当一个回合被切开时，分别摘要旧历史与该回合的前半段。",
      principle: "允许从一轮长任务中间接续，同时把切点之前的工作交代清楚。",
      retention: "约 20k tokens 近期内容", recovery: "历史摘要、回合前缀与文件清单",
      caveat: "保留量是切点目标，完整工具对可能使实际保留更多。分支摘要有独立接口，此处不模拟原生会话树。",
      steps: ["估算剩余空间", "保留工具结构", "寻找安全切点", "分别摘要两段", "累计文件清单"],
      details: ["结合估算与 API usage，在窗口减去 16,384 tokens 后触发。", "没有独立的微压缩阶段。工具调用与结果参与切点选择。", "从尾部保留约 20k tokens，允许切开回合，但不拆散工具调用对。", "旧历史生成主摘要；被切开的回合前缀可生成第二份摘要，再组合接续上下文。", "累计读取、修改的文件记录，近期尾部以原文保留。"],
    },
    en: {
      subtitle: "Cut points & dual summaries", description: "Find a safe cut point by token budget. When it splits a turn, summarize older history and the turn prefix separately.",
      principle: "Continue midway through a long turn, while explicitly handing over the work before the cut.",
      retention: "About 20k recent tokens", recovery: "History, turn prefix & file list",
      caveat: "Retention is a cut-point target; complete tool pairs may retain more. Branch summarization has a separate API; the native session-tree UI is not simulated.",
      steps: ["Estimate free space", "Preserve tool structure", "Find a safe cut", "Summarize both spans", "Accumulate file list"],
      details: ["Combine estimates with API usage and trigger at the window minus 16,384 tokens.", "There is no standalone microcompaction. Tool calls and results inform cut-point selection.", "Keep about 20k tokens from the tail. A turn may be split, but tool pairs remain intact.", "Summarize older history; a split-turn prefix can receive a second summary, then combine the handoff.", "Accumulate read and modified file records and preserve the recent tail verbatim."],
    },
  },
  {
    id: "qwen-code", name: "Qwen Code", mark: "qw", color: "#8069a5", trigger: "min(0.85W, W − 33,000)", pruning: "default", source: docs("qwen-code"), revision: "151a6bc",
    zh: {
      subtitle: "多模态状态快照", description: "工具文本与截图都可提前触发清理。用结构化状态快照承接历史，并按路径恢复文件和图片。",
      principle: "文本与图片都消耗上下文，恢复材料也必须受最终检查点的预算约束。",
      retention: "默认全量，可配置尾部", recovery: "最多 5 个文件与 3 张图片",
      caveat: "参考本地 fork，不能归为当前上游默认行为。HTTP 413 恢复路径不重新附加文件和图片。",
      steps: ["观察用量与截图", "清理文本与图片", "选择完整历史", "校验状态快照", "按路径恢复现场"],
      details: ["usage 锚点后的新增内容有 1.5 倍余量；默认 20 张工具截图也能触发压缩。", "微压缩默认开启。工具文本超过 500k 字符时向 250k 清理，保护近期工具与错误。", "默认全量选择，保护指令和未完成调用，普通摘要不截短工具文本。", "要求完整非空的 state_snapshot；摘要模型溢出先回退主模型，再缩小完整调用组。", "正常路径恢复计划、技能、文件和最多 3 张图片；HTTP 413 抑制文件与图片重新附加。"],
    },
    en: {
      subtitle: "Multimodal state snapshots", description: "Tool text and screenshots can trigger early cleanup. A structured state snapshot carries history into the next request.",
      principle: "Text and images both consume context. Restored material must also fit the final checkpoint budget.",
      retention: "Full history by default; optional tail", recovery: "Up to 5 files & 3 images",
      caveat: "Based on a local fork, not current upstream defaults. HTTP 413 recovery suppresses file and image reattachment.",
      steps: ["Track usage & images", "Clean text & images", "Select full history", "Validate state snapshot", "Restore by error path"],
      details: ["New content after the usage anchor gets a 1.5× margin; 20 tool screenshots can also trigger compaction.", "Microcompaction is enabled. Above 500k characters, reduce tool text toward 250k while protecting recent results and errors.", "Select all eligible history, protecting instructions and open calls. Normal summary input retains tool text.", "Require a complete, nonempty state_snapshot. On overflow, fall back to the main model, then shrink complete groups.", "Normally restore plans, skills, files, and up to 3 images. HTTP 413 suppresses file and image reattachment."],
    },
  },
  {
    id: "zcode", name: "ZCode", mark: "z", color: "#45848a", trigger: "W − min(O, 21,000) − 13,000", pruning: "default", source: docs("zcode"), revision: "29628c9",
    zh: {
      subtitle: "按组清理与恢复", description: "以 assistant 轮次选择历史。自动流程先清理旧工具批次，摘要后恢复计划和近期文件。",
      principle: "工具按批次清理，历史按轮次选择，工作现场在摘要后重建。",
      retention: "自动留最后一轮；手动全选", recovery: "九节摘要、计划与文件",
      caveat: "手动压缩跳过 prune。已完成的微压缩不会因后续摘要失败而撤销，原始消息仍在日志中。",
      steps: ["对齐 usage 锚点", "按批次清理", "选择 assistant 轮次", "生成九节摘要", "恢复计划与文件"],
      details: ["累计 provider usage 与后续消息，只扣除已包含在锚点中的裁剪量。", "自动流程保护最近 5 组有效结果、错误与媒体；手动流程跳过剪枝。", "自动和溢出恢复保留最后一轮；手动选择全部，至少需要两个可摘要轮次。", "溢出时缩小辅助输入或增加保留轮次；媒体失败后尝试无媒体输入。", "恢复已观察到的计划、TODO 和最多 5 个成功读取的文件；超预算时保留引用。"],
    },
    en: {
      subtitle: "Grouped cleanup & recovery", description: "Select history by assistant turns. Automatic runs clean old tool batches before summarizing and restoring plans and files.",
      principle: "Prune tools by batch, select history by turn, and reconstruct working state after the summary.",
      retention: "Last turn on auto; all on manual", recovery: "Nine-part summary, plans & files",
      caveat: "Manual compaction skips pruning. Completed pruning persists if summarization later fails; original messages remain in the log.",
      steps: ["Align usage anchor", "Prune tool batches", "Select assistant turns", "Create nine-part summary", "Restore plans & files"],
      details: ["Add provider usage and later messages. Deduct only savings already included in the usage anchor.", "Automatic runs protect 5 recent eligible batches, errors, and media. Manual runs skip this step.", "Keep the last turn on automatic and overflow paths; select all on manual. Require at least 2 eligible turns.", "On overflow, shrink auxiliary input or retain more turns. Retry without media after media errors.", "Restore observed plans, TODOs, and up to 5 successfully read files; retain references when over budget."],
    },
  },
  {
    id: "kimi-code", name: "Kimi Code", mark: "k", color: "#5d7796", trigger: "min(0.85W, W − 50,000)", pruning: "none", source: docs("kimi-code"), revision: "be7d5f5",
    zh: {
      subtitle: "完整摘要与意图恢复", description: "摘要选中段的完整历史，再从持久日志中找回真正的用户输入，守住长任务的原始约束。",
      principle: "完整摘要之后，原始用户输入仍会独立恢复，并与 TODO 一起接续任务。",
      retention: "20k tokens 用户输入恢复预算", recovery: "用户原文、TODO 与日志入口",
      caveat: "20k 是用户输入恢复预算，不是近期尾部。超出时保留最早 2k 与最新 18k，中间加入省略提示。",
      steps: ["检查有效容量", "预整理摘要输入", "选择完整历史", "逐级缩小重试", "找回原始意图"],
      details: ["窗口达到 85% 或剩余不超过 50k 时触发；压缩后用量未增长则不重复运行。", "无工具微压缩。为摘要输出预留预算，必要时仅缩小辅助输入。", "汇总首个可处理段的完整历史；按消息 ID 去重，恢复真正的用户输入。", "溢出时按 70%、50%、35% 缩减输入，最多请求 5 次；暂时错误指数退避。", "在 20k 预算内恢复用户原文，附带已观察到的 TODO 和真实日志入口。"],
    },
    en: {
      subtitle: "Full summary & intent recovery", description: "Summarize the entire selected history, then recover real user input from the durable log to preserve original constraints.",
      principle: "After a full summary, restore original user input separately and carry TODO state into the next step.",
      retention: "20k-token user-input recovery budget", recovery: "User text, TODOs & log references",
      caveat: "20k is a user-input recovery budget, not a recent tail. When exceeded, keep the first 2k and latest 18k with an omission marker.",
      steps: ["Check effective capacity", "Prepare summary input", "Select entire history", "Shrink & retry", "Recover original intent"],
      details: ["Trigger at 85% of the window or with 50k remaining. Do not repeat if usage has not grown since compaction.", "No tool microcompaction. Reserve summary output space and shrink only auxiliary input when necessary.", "Summarize the first eligible full span; deduplicate original user input by message ID.", "Shrink overflow input to 70%, 50%, then 35%, with up to 5 requests; back off on transient errors.", "Restore original user text within 20k tokens and add observed TODOs and real log references."],
    },
  },
  {
    id: "cline", name: "Cline", mark: "cl", color: "#637e8a", trigger: "0.9 × usable input ≈ 0.81W", pruning: "none", source: docs("cline"), revision: "252082b",
    zh: {
      subtitle: "摘要与无模型回退", description: "保留约 20k tokens 近期历史。摘要调用异常或发生溢出时，用确定性检查点继续。",
      principle: "恢复不必总依赖另一轮模型调用。basic 回退保留用户原文、已有检查点和文件活动。",
      retention: "约 20k tokens 近期历史", recovery: "摘要异常或溢出 → basic 检查点",
      caveat: "取消、空输出与被拒绝的摘要不会触发 basic 回退。回退不读取文件，也不重建原生 Cline 运行环境。",
      steps: ["校正请求预算", "整理辅助请求", "保留近期后缀", "摘要或 basic 回退", "校验并提交"],
      details: ["根据有效输入 usage 校正预算；无独立输入上限时使用窗口的 90%。", "无独立工具剪枝。摘要请求中的工具文本与附件默认限制为 2,000 字符。", "尽量保留约 20k tokens 和最新用户回合，切点向前对齐完整调用对。", "模型摘要调用抛异常时回退；上下文溢出与 HTTP 413 直接使用不依赖模型的恢复。", "结果必须有效、更小且输入未变；记录文件活动，保留未选中的近期后缀。"],
    },
    en: {
      subtitle: "Summary & model-free fallback", description: "Keep about 20k tokens of recent history. On summary exceptions or context overflow, continue with a deterministic checkpoint.",
      principle: "Recovery need not require another model request. The basic fallback preserves user text, prior checkpoints, and file activity.",
      retention: "About 20k recent tokens", recovery: "Exception / overflow → basic checkpoint",
      caveat: "Cancellation, empty output, and rejected summaries do not trigger basic fallback. It does not read files or reconstruct the native Cline runtime.",
      steps: ["Calibrate request budget", "Prepare auxiliary input", "Keep a recent suffix", "Summarize or fall back", "Validate & commit"],
      details: ["Calibrate from valid input usage. Without a separate input limit, usable input is 90% of the window.", "No separate tool pruning. Summary input limits each tool-text segment and attachment to 2,000 characters by default.", "Aim to retain 20k tokens and the latest user turn. Align the cut with complete tool pairs.", "Fall back on a thrown summary exception; context overflow and HTTP 413 use model-free recovery directly.", "Require a valid, smaller result and unchanged input. Record file activity and preserve the unselected recent suffix."],
    },
  },
];

/** Illustrates default budgets with an 8,192-token output cap and no separate input limit. */
export function budgetFor(id: StrategyId, window: number, output = 8192) {
  let trigger = 0;
  let retain = 0;
  switch (id) {
    case "deepseek": trigger = Math.min(window * .8, window - output - 65536); retain = (window - output) * .16; break;
    case "claude-code": trigger = window - Math.min(output, 20000) - 13000; break;
    case "codex": trigger = window * .9; retain = 20000; break;
    case "opencode": trigger = window - output; retain = Math.min(15000, Math.max(2000, trigger * .25)); break;
    case "pi": trigger = window - 16384; retain = 20000; break;
    case "qwen-code": { const ceiling = window - 33000; trigger = ceiling > 0 ? Math.min(window * .85, ceiling) : window * .85; break; }
    case "zcode": trigger = window - Math.min(output, 21000) - 13000; break;
    case "kimi-code": trigger = window > 50000 ? Math.min(window * .85, window - 50000) : window * .85; retain = 20000; break;
    case "cline": trigger = window * .9 * .9; retain = 20000; break;
  }
  return { trigger: Math.max(0, Math.floor(trigger)), retain: Math.max(0, Math.floor(retain)), valid: trigger > 0 && (id !== "deepseek" || retain < trigger) };
}

export const observations = [
  { id: "claude-code", after: 1937, reduction: 64.8, cap: 2048, fixed: "43/43", fixedCompactions: 2, nativeCompactions: 3 },
  { id: "codex", after: 1366, reduction: 75.2, cap: 2048, fixed: "43/43", fixedCompactions: 2, nativeCompactions: 3 },
  { id: "opencode", after: 1132, reduction: 79.4, cap: 2048, fixed: "43/43", fixedCompactions: 2, nativeCompactions: 1 },
  { id: "pi", after: 1594, reduction: 71, cap: 2048, fixed: "43/43", fixedCompactions: 3, nativeCompactions: 0 },
  { id: "qwen-code", after: 2706, reduction: 50.9, cap: 4096, fixed: "37/43", fixedCompactions: 2, nativeCompactions: 3 },
  { id: "zcode", after: 5236, reduction: 4.9, cap: 2048, fixed: null, fixedCompactions: 0, nativeCompactions: 3 },
  { id: "kimi-code", after: 1646, reduction: 70.1, cap: 2048, fixed: "43/43", fixedCompactions: 3, nativeCompactions: 3 },
  { id: "cline", after: 1844, reduction: 66.5, cap: 2048, fixed: "43/43", fixedCompactions: 3, nativeCompactions: 2 },
] as const;
