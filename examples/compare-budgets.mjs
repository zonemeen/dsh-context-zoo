import { strategy as claude } from '../packages/claude-code/dist/index.js';
import { strategy as opencode } from '../packages/opencode/dist/index.js';
import { strategy as pi } from '../packages/pi/dist/index.js';
import { strategy as qwen } from '../packages/qwen-code/dist/index.js';
import { strategy as zcode } from '../packages/zcode/dist/index.js';
import { strategy as kimi } from '../packages/kimi-code/dist/index.js';
const contextWindow = Number(process.argv[2] ?? 200_000);
const maxOutputTokens = Number(process.argv[3] ?? 32_000);
if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0) throw new Error('Usage: pnpm compare [positive context window] [non-negative output tokens]');
console.table([claude, opencode, pi, qwen, zcode, kimi].map(strategy => {
  const budget = strategy.budget({contextWindow, maxOutputTokens});
  return {strategy: strategy.id, trigger: `${budget.strict ? '>' : '>='} ${budget.triggerTokens}`, recentTokens: budget.retainTokens, lastRound: budget.retainLastRound ?? false, pruning: strategy.prune.enabled};
}));
