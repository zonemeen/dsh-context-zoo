/** Local context compaction plugin for DeepSeek Harness. */
import { createContextPlugin, type ContextStrategy } from 'dsh-context-core';
import { createPipeline, summaryInstruction } from './pipeline.js';
export { createPipeline } from './pipeline.js';

/** Comparison metadata for the pinned Codex local summarization workflow. */
export const strategy: ContextStrategy = {
  id: 'codex',
  name: 'Codex',
  source: {
    url: 'https://github.com/openai/codex',
    revision: 'e72da2b53805894878023d01949a25a082e0a5cb',
    license: 'Apache-2.0',
  },
  limitations: [
    'Implements the local summarizing path. Remote Responses compaction V2 requires native CompactionTrigger and opaque Compaction items that the DSH model interface cannot carry.',
    'DSH preserves system/developer messages and compacts one completed contiguous span into one user checkpoint. Retained user blocks and injected context keep their order inside that checkpoint; original message identities are not preserved.',
    'Token-budget resets, post-turn scheduling, model-switch compatibility hashes, provider transport retries, and Codex compact hooks require native host capabilities and are not simulated.',
    'Usage uses DSH aggregate prompt/output accounting and UTF-8 estimates. Body-after-prefix budgets, encrypted reasoning, original-detail image sizing, and Codex world-state reconstruction are unavailable through this host.',
    'DSH commits checkpoints atomically and rejects empty, truncated, or non-shrinking summaries. Context-window recovery applies to summary requests; ordinary failed model requests are left to the host.',
  ],
  budget(input) {
    return {
      triggerTokens: Math.max(0, Math.min(
        Math.floor(input.contextWindow * Math.min(0.9, input.thresholdRatio ?? 0.9)),
        input.contextWindow - (input.reserveTokens ?? 0),
      )),
      retainTokens: input.keepRecentTokens ?? 20_000,
    };
  },
  summaryInstructions: summaryInstruction,
  maxSummaryTokens: 32_000,
  summaryToolChars: 0,
  prune: { enabled: false, keepRecentTools: 0, protectTokens: 0, minSavingsTokens: 0 },
};

export default createContextPlugin({ id: strategy.id, create: createPipeline });
