/** Kimi Code's full-history compaction and original user input restoration. */
import { createContextPlugin, type ContextStrategy } from '@dsh-context-zoo/core';
import { createPipeline, SUMMARY_INSTRUCTIONS } from './pipeline.js';
export { createPipeline } from './pipeline.js';

/** Strategy adapted from Kimi Code's pinned fullCompaction implementation. */
export const strategy: ContextStrategy = {
  id: 'kimi-code',
  name: 'Kimi Code',
  source: {
    url: 'https://github.com/MoonshotAI/kimi-code',
    revision: 'be7d5f5fea7800778e4660cd5f36780ba783bddd',
    license: 'MIT',
  },
  limitations: [
    'Targets the called fullCompactionService and contextMemory/compactionHandoff flow, including its original-user restoration.',
    'DSH owns durable transactions and provider transport; Kimi policy, retries, user selection and recovery formatting belong to this package.',
    'Wire-log paths and live TODO state are included only when observed by the host or recovered from durable successful tool exchanges.',
  ],
  budget(input) {
    const reserve = input.reserveTokens ?? 50_000;
    const ratioThreshold = Math.ceil(input.contextWindow * (input.thresholdRatio ?? 0.85));
    const reserveThreshold = reserve > 0 && reserve < input.contextWindow
      ? input.contextWindow - reserve
      : input.contextWindow;
    return {
      triggerTokens: Math.min(ratioThreshold, reserveThreshold),
      retainTokens: input.keepRecentTokens ?? 20_000,
    };
  },
  summaryInstructions: SUMMARY_INSTRUCTIONS,
  maxSummaryTokens: 128 * 1_024,
  summaryToolChars: 0,
  prune: {
    enabled: false,
    keepRecentTools: 0,
    protectTokens: 0,
    minSavingsTokens: 0,
  },
};

export default createContextPlugin({ id: strategy.id, create: createPipeline });
