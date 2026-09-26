import type { ContextConfig } from './types.js';

const integerKeys = ['reserveTokens', 'keepRecentTokens', 'maxSummaryTokens', 'summaryToolChars', 'maxOverflowRetries', 'maxConsecutiveFailures', 'keepRecentTools', 'protectToolTokens', 'minPruneTokens', 'screenshotTriggerImages', 'tailTurns', 'summaryRetryDelayMs', 'idleMinutes', 'toolHighWaterChars', 'toolLowWaterChars', 'maxSummaryAttempts', 'maxRestoredFiles', 'maxFileTokens', 'maxRestoreTokens', 'maxRestoredImages', 'maxSkillTokens'] as const;
const keys = new Set<string>([...integerKeys, 'auto', 'thresholdRatio', 'summarizationProvider', 'summarizationModel', 'prune', 'restoreContext']);

/** Validate YAML/JSON plugin settings before registering any listeners. */
export function validateConfig(config: ContextConfig): void {
  for (const key of Object.keys(config)) if (!keys.has(key)) throw new Error(`Unknown context setting: ${key}`);
  for (const key of integerKeys) {
    const value = config[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${key} must be a non-negative safe integer`);
  }
  for (const key of ['maxSummaryTokens', 'maxConsecutiveFailures', 'maxSummaryAttempts'] as const) if (config[key] === 0) throw new Error(`${key} must be positive`);
  for (const key of ['auto', 'prune', 'restoreContext'] as const) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  if (config.thresholdRatio !== undefined && (!Number.isFinite(config.thresholdRatio) || config.thresholdRatio <= 0 || config.thresholdRatio > 1)) throw new Error('thresholdRatio must be greater than 0 and at most 1');
  for (const key of ['summarizationProvider', 'summarizationModel'] as const) if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].trim().length === 0)) throw new Error(`${key} must be a non-empty string`);
  if ((config.summarizationProvider === undefined) !== (config.summarizationModel === undefined)) throw new Error('Set summarizationProvider and summarizationModel together');
}
