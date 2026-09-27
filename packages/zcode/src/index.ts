/** ZCode-inspired context budgets, round retention, and tool-result pruning. */
import { createContextPlugin, type ContextStrategy } from 'dsh-context-core';
import { createPipeline, SUMMARY_INSTRUCTIONS } from './pipeline.js';
export { createPipeline } from './pipeline.js';

/** Strategy adapted from the CLI compaction implementation in the pinned ZCode revision. */
export const strategy: ContextStrategy = {
  id: 'zcode',
  name: 'ZCode',
  source: {
    url: 'https://github.com/zai-org/ZCode',
    revision: '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
    license: 'Apache-2.0',
  },
  limitations: [
    'DSH owns durable transactions and provider transport; this package owns ZCode policy, usage anchors, round selection and retries.',
    'Host-specific recovery notices are restored only from observed host metadata; an absent REPL is never reported as cleared.',
    'Tool names include explicit DSH aliases; source model-specific media encoding remains owned by the installed DSH provider.',
  ],
  budget(input) {
    const reserve = input.reserveTokens ?? Math.min(input.maxOutputTokens, 21_000);
    return {
      triggerTokens: Math.max(0, input.thresholdRatio === undefined
        ? input.contextWindow - reserve - 13_000
        : Math.floor(input.contextWindow * input.thresholdRatio)),
      retainTokens: input.keepRecentTokens ?? 0,
      retainLastRound: true,
    };
  },
  summaryInstructions: SUMMARY_INSTRUCTIONS,
  maxSummaryTokens: 20_000,
  summaryToolChars: 0,
  prune: {
    enabled: true,
    keepRecentTools: 5,
    protectTokens: 0,
    minSavingsTokens: 256,
    triggerRatio: 0.9,
    triggerBufferTokens: 2_000,
    groupByAssistant: true,
    eligibleTools: [
      'read', 'readfile', 'bash', 'shell', 'execcommand', 'grep', 'glob',
      'webfetch', 'websearch', 'edit', 'editfile', 'write', 'writefile', 'applypatch',
    ],
  },
};

export default createContextPlugin({ id: strategy.id, create: createPipeline });
