import { budgetFor, type StrategyId } from "./strategies.ts";

export type ScenarioId = "coding" | "tools" | "requirements";
export type BlockKind = "system" | "dialogue" | "tool" | "recent" | "summary" | "restored";
export type TraceBlock = { kind: BlockKind; tokens: number; id: string };
export type Trace = { before: TraceBlock[]; after: TraceBlock[]; beforeTokens: number; afterTokens: number; prunedTokens: number; hasPruning: boolean; hasTail: boolean; restored: boolean };

/** Deterministic teaching fixture, not an execution or benchmark of the actual plugins. */
export function simulate(id: StrategyId, window: number, scenario: ScenarioId): Trace {
  const scale = window / 131072;
  const tokens = (value: number) => Math.round(value * scale);
  const toolWeight = scenario === "tools" ? 1.6 : scenario === "requirements" ? .65 : 1;
  const dialogueWeight = scenario === "requirements" ? 1.8 : 1;
  const before: TraceBlock[] = [
    { id: "system", kind: "system", tokens: tokens(3600) },
    { id: "user-a", kind: "dialogue", tokens: tokens(7400 * dialogueWeight) },
    { id: "tool-a", kind: "tool", tokens: tokens(18500 * toolWeight) },
    { id: "dialogue", kind: "dialogue", tokens: tokens(8200 * dialogueWeight) },
    { id: "tool-b", kind: "tool", tokens: tokens(23900 * toolWeight) },
    { id: "tool-c", kind: "tool", tokens: tokens(16300 * toolWeight) },
    { id: "recent", kind: "recent", tokens: tokens(18700) },
  ];
  // This selected path assumes the native pruner is mounted and Qwen's cleanup conditions are met.
  // ZCode illustrates its manual path, which skips pruning. Other optional pruners stay disabled.
  const hasPruning = id === "deepseek" || id === "qwen-code";
  const prunedTokens = hasPruning ? Math.round(before.filter(b => b.kind === "tool").reduce((sum, b) => sum + b.tokens, 0) * .48) : 0;
  const hasTail = ["deepseek", "opencode", "pi", "cline"].includes(id);
  const restored = ["claude-code", "codex", "qwen-code", "zcode", "kimi-code"].includes(id);
  const beforeTokens = before.reduce((sum, block) => sum + block.tokens, 0);
  const after: TraceBlock[] = [before[0], { id: "summary", kind: "summary", tokens: tokens(id === "pi" ? 4300 : 3200) }];
  if (hasTail) after.push({ id: "tail", kind: "recent", tokens: Math.min(budgetFor(id, window).retain, tokens(18700)) });
  if (restored) after.push({ id: "restored", kind: "restored", tokens: tokens(id === "zcode" ? 19600 : id === "codex" || id === "kimi-code" ? 10800 : 12600) });
  const afterTokens = after.reduce((sum, block) => sum + block.tokens, 0);
  return { before, after, beforeTokens, afterTokens, prunedTokens, hasPruning, hasTail, restored };
}
