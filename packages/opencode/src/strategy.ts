/** OpenCode context-budget, recent-history, and optional output-pruning strategy. */
import type { ContextStrategy } from '@dsh-context-zoo/core';

/** Adaptation of the pinned OpenCode session compaction implementation. */
export const strategy: ContextStrategy = {
  id: 'opencode',
  name: 'OpenCode',
  source: {
    url: 'https://github.com/anomalyco/opencode',
    revision: 'beb99270834db8eb62cf3a369e99234d4d4c2cbd',
    license: 'MIT',
  },
  limitations: [
    'DSH message blocks are serialized by this package; provider-specific OpenCode wire encoders and third-party OpenCode hooks require their native runtime.',
    'Tool-call pairs remain complete when a DSH message boundary differs from an OpenCode assistant part.',
  ],
  budget(input) {
    const reserve = input.reserveTokens ?? (input.maxOutputTokens || 32_000);
    const usable = Math.max(0, input.contextWindow - reserve);
    return {
      triggerTokens: Math.floor(usable * (input.thresholdRatio ?? 1)),
      retainTokens: input.keepRecentTokens ?? Math.min(15_000, Math.max(2_000, Math.floor(usable * 0.25))),
      tailMode: 'maximum',
    };
  },
  summaryInstructions: `Write a concise handoff using these headings in order:
## Objective
## Important Details
## Work State
### Completed
### Active
### Blocked
## Next Move
## Relevant Files

Record the user's goal, constraints, decisions, completed work, pending work, blockers, and next actions. Include exact paths, symbols, commands, and errors needed to continue. Integrate any prior summary; resolve conflicting facts using the newer conversation. Keep unfinished requests and relevant earlier decisions. Use short bullets and keep empty sections with "(none)".`,
  maxSummaryTokens: 32_000,
  summaryToolChars: 2_000,
  prune: {
    enabled: false,
    keepRecentTools: 0,
    keepRecentTurns: 2,
    protectTokens: 40_000,
    minSavingsTokens: 20_000,
    strictSavings: true,
    protectedTools: ['skill'],
  },
};
