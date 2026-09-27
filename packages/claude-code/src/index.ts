/** Context budgets and summarization based on the observed Claude Code 2.1.88 behavior. */
import { createContextPlugin, type ContextStrategy } from 'dsh-context-core';
import { createPipeline, summaryInstruction } from './pipeline.js';
export { createPipeline } from './pipeline.js';

/** Comparison metadata for the observed Claude Code 2.1.88 workflow. */
export const strategy: ContextStrategy = {
  id: 'claude-code',
  name: 'Claude Code 2.1.88-inspired',
  source: {
    url: 'https://github.com/anthropics/claude-code',
    revision: 'recovered @anthropic-ai/claude-code 2.1.88; local copy has no Git revision',
    license: 'No open-source license found in the local recovery; reference code and prompts are not copied',
  },
  limitations: [
    'The reference is an unofficial source recovery of 2.1.88; private feature-gated cache-edit and session-memory APIs are unavailable through the DSH model interface.',
    'DSH message sources supply instruction, skill, plan and agent-state recovery; provider-native attachment objects and internal feature flags do not cross this host interface.',
  ],
  budget(input) {
    const reserve = input.reserveTokens ?? Math.min(input.maxOutputTokens, 20_000);
    const effectiveWindow = Math.max(0, input.contextWindow - reserve);
    const ceiling = effectiveWindow - 13_000;
    const trigger = input.thresholdRatio === undefined
      ? ceiling
      : Math.min(Math.floor(effectiveWindow * input.thresholdRatio), ceiling);
    return {
      triggerTokens: Math.max(0, trigger),
      retainTokens: input.keepRecentTokens ?? 0,
    };
  },
  summaryInstructions: summaryInstruction,
  maxSummaryTokens: 20_000,
  summaryToolChars: 0,
  prune: {
    enabled: false,
    keepRecentTools: 5,
    protectTokens: 0,
    minSavingsTokens: 0,
  },
};

export default createContextPlugin({ id: strategy.id, create: createPipeline });
