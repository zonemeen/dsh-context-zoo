/** Context policy adapted from the pinned zonemeen Qwen Code fork. */
import { createContextPlugin, type ContextStrategy } from '@dsh-context-zoo/core';
import { createPipeline, summaryInstruction } from './pipeline.js';
export { createPipeline } from './pipeline.js';

/** Comparison metadata for the zonemeen fork's independently owned context workflow. */
export const strategy: ContextStrategy = {
  id: 'qwen-code',
  name: 'Qwen Code (zonemeen fork)',
  source: {
    url: 'https://github.com/QwenLM/qwen-code',
    revision: '151a6bc5aff6287264f81968efb7a19c37f3c03e',
    license: 'Apache-2.0',
  },
  limitations: [
    'The reference is the pinned zonemeen fork, not QwenLM upstream current behavior.',
    "Provider-native cache-sharing requests and Qwen-specific hook endpoints are unavailable through DSH's model interface; durable DSH context sources carry plan, instruction, skill and agent state.",
  ],
  budget(input) {
    const reserve = input.reserveTokens ?? 20_000;
    const effectiveWindow = Math.max(0, input.contextWindow - reserve);
    const ceiling = effectiveWindow - 13_000;
    const proportional = (input.thresholdRatio ?? 0.85) * input.contextWindow;
    return {
      triggerTokens: Math.floor(ceiling > 0 ? Math.min(proportional, ceiling) : proportional),
      retainTokens: input.keepRecentTokens ?? 0,
    };
  },
  summaryInstructions: summaryInstruction,
  maxSummaryTokens: 20_000,
  summaryToolChars: 0,
  prune: {
    enabled: true,
    keepRecentTools: 5,
    protectTokens: 0,
    minSavingsTokens: 0,
  },
};

export default createContextPlugin({ id: strategy.id, create: createPipeline });
