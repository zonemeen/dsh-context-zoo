import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../packages/core/dist/index.js';

test('configuration accepts explicit zero budgets and disabled automation', () => {
  assert.doesNotThrow(() => validateConfig({auto: false, reserveTokens: 0, keepRecentTokens: 0, summaryToolChars: 0, maxOverflowRetries: 0, prune: false}));
});

test('configuration rejects misspellings, invalid budgets, and partial model routes', () => {
  for (const config of [{retianTokens: 10}, {reserveTokens: -1}, {keepRecentTokens: 1.5}, {maxSummaryTokens: 0}, {thresholdRatio: NaN}, {thresholdRatio: 0}, {thresholdRatio: 2}, {auto: 'false'}, {summarizationProvider: 'api'}, {summarizationProvider: '', summarizationModel: 'test'}]) {
    assert.throws(() => validateConfig(config));
  }
});
