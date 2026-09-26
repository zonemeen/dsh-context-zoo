import assert from 'node:assert/strict';
import test from 'node:test';
import * as claudeCode from '../packages/claude-code/dist/index.js';
import * as opencode from '../packages/opencode/dist/index.js';
import * as pi from '../packages/pi/dist/index.js';
import * as qwenCode from '../packages/qwen-code/dist/index.js';
import * as zcode from '../packages/zcode/dist/index.js';
import * as kimiCode from '../packages/kimi-code/dist/index.js';

const modules = [claudeCode, opencode, pi, qwenCode, zcode, kimiCode];
const window200k = { contextWindow: 200_000, maxOutputTokens: 32_000 };

test('each agent exposes a separately selectable strategy and plugin', () => {
  assert.deepEqual(modules.map(({ strategy }) => strategy.id), [
    'claude-code', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code',
  ]);
  assert.equal(new Set(modules.map(({ strategy }) => strategy)).size, 6);
  assert.equal(new Set(modules.map(({ default: plugin }) => plugin)).size, 6);
  for (const { default: plugin } of modules) {
    assert.ok(plugin !== null && ['object', 'function'].includes(typeof plugin));
  }
});

test('source strategies retain their different thresholds in a 200k window', () => {
  const cases = [
    [claudeCode, 167_000, 0],
    [opencode, 168_000, 15_000],
    [pi, 183_616, 20_000],
    [qwenCode, 167_000, 0],
    [zcode, 166_000, 0],
    [kimiCode, 150_000, 20_000],
  ];
  for (const [{ strategy }, triggerTokens, retainTokens] of cases) {
    const budget = strategy.budget(window200k);
    assert.equal(budget.triggerTokens, triggerTokens, `${strategy.id}: trigger`);
    assert.equal(budget.retainTokens, retainTokens, `${strategy.id}: retention`);
  }
  assert.equal(zcode.strategy.budget(window200k).retainLastRound, true);
  assert.equal(kimiCode.strategy.budget(window200k).minRecentMessages, undefined);
});

test('explicit reserve and retention values replace the source defaults', () => {
  const expectedThresholds = [177_000, 190_000, 190_000, 170_000, 177_000, 170_000];
  for (const [index, { strategy }] of modules.entries()) {
    const budget = strategy.budget({ ...window200k, reserveTokens: 10_000, keepRecentTokens: 1_234 });
    assert.equal(budget.triggerTokens, expectedThresholds[index], strategy.id);
    assert.equal(budget.retainTokens, 1_234, strategy.id);
  }
});

test('ratio overrides preserve each source strategy’s reserve and ceiling rules', () => {
  const expectedThresholds = [95_000, 95_000, 95_000, 100_000, 100_000, 100_000];
  for (const [index, { strategy }] of modules.entries()) {
    const budget = strategy.budget({
      ...window200k,
      reserveTokens: 10_000,
      thresholdRatio: 0.5,
      keepRecentTokens: 1_234,
    });
    assert.equal(budget.triggerTokens, expectedThresholds[index], strategy.id);
    assert.equal(budget.retainTokens, 1_234, strategy.id);
  }
  assert.equal(claudeCode.strategy.budget({ ...window200k, thresholdRatio: 1 }).triggerTokens, 167_000);
  assert.equal(qwenCode.strategy.budget({ ...window200k, thresholdRatio: 1 }).triggerTokens, 167_000);
});

test('zero retention and zero reserve overrides are honored', () => {
  for (const { strategy } of modules) {
    assert.equal(strategy.budget({ ...window200k, keepRecentTokens: 0 }).retainTokens, 0, strategy.id);
  }
  assert.equal(pi.strategy.budget({ ...window200k, reserveTokens: 0 }).triggerTokens, 200_000);
  assert.equal(opencode.strategy.budget({ ...window200k, reserveTokens: 0 }).triggerTokens, 200_000);
});

test('OpenCode retention follows the usable window and stays within its default limits', () => {
  assert.equal(opencode.strategy.budget({ contextWindow: 36_000, maxOutputTokens: 32_000 }).retainTokens, 2_000);
  assert.equal(opencode.strategy.budget({ contextWindow: 72_000, maxOutputTokens: 32_000 }).retainTokens, 10_000);
  assert.equal(opencode.strategy.budget(window200k).retainTokens, 15_000);
  assert.equal(opencode.strategy.budget({ contextWindow: 200_000, maxOutputTokens: 0 }).triggerTokens, 168_000);
  assert.equal(opencode.strategy.budget(window200k).tailMode, 'maximum');
});

test('Pi requests a strict threshold and minimum recent-history budget', () => {
  const budget = pi.strategy.budget(window200k);
  assert.equal(budget.strict, true, 'At exactly 183,616 tokens Pi must wait for a further token.');
  assert.equal(budget.tailMode, 'minimum');
  for (const { strategy } of modules.filter(({ strategy }) => strategy.id !== 'pi')) {
    assert.notEqual(strategy.budget(window200k).strict, true, strategy.id);
  }
});

test('Kimi ignores a reserve that would consume the entire window', () => {
  assert.equal(kimiCode.strategy.budget({ contextWindow: 50_000, maxOutputTokens: 8_000 }).triggerTokens, 42_500);
  assert.equal(kimiCode.strategy.budget({ contextWindow: 40_000, maxOutputTokens: 8_000 }).triggerTokens, 34_000);
  assert.equal(kimiCode.strategy.budget({ contextWindow: 50_001, maxOutputTokens: 8_000 }).triggerTokens, 1);
  assert.equal(kimiCode.strategy.budget({ ...window200k, reserveTokens: 0 }).triggerTokens, 170_000);
  assert.equal(kimiCode.strategy.budget(window200k).tailMode, undefined);
});

test('source references link original projects and preserve inspected local revisions', () => {
  const sources = [
    [opencode, 'https://github.com/anomalyco/opencode', 'beb99270834db8eb62cf3a369e99234d4d4c2cbd', 'MIT'],
    [pi, 'https://github.com/earendil-works/pi', '8a7b0c03dfb702663acafb6dc29f8acaa4ffe391', 'MIT'],
    [qwenCode, 'https://github.com/QwenLM/qwen-code', '151a6bc5aff6287264f81968efb7a19c37f3c03e', 'Apache-2.0'],
    [zcode, 'https://github.com/zai-org/ZCode', '29628c9acdb81b703bbd4080c207a0e7ce5e276e', 'Apache-2.0'],
    [kimiCode, 'https://github.com/MoonshotAI/kimi-code', 'be7d5f5fea7800778e4660cd5f36780ba783bddd', 'MIT'],
  ];
  for (const [{ strategy }, url, revision, license] of sources) {
    assert.deepEqual(strategy.source, { url, revision, license });
  }
  assert.equal(claudeCode.strategy.source.url, 'https://github.com/anthropics/claude-code');
  assert.match(claudeCode.strategy.source.revision, /2\.1\.88/);
  assert.match(claudeCode.strategy.source.revision, /no Git revision/);
  assert.match(claudeCode.strategy.source.license, /No open-source license/);
});

test('summary instructions preserve source-specific continuation information', () => {
  assert.equal(new Set(modules.map(({ strategy }) => strategy.summaryInstructions)).size, 6);
  const expectations = [
    [claudeCode, /User corrections/, /permission limits/],
    [opencode, /## Work State/, /## Relevant Files/],
    [pi, /## Constraints & Preferences/, /## Key Decisions/],
    [qwenCode, /failures_and_fixes/, /pending_tasks/],
    [zcode, /User Messages and Constraints/, /latest unfinished (request|task)/],
    [kimiCode, /structure appropriate to the task/, /unverified claims/],
  ];
  for (const [{ strategy }, ...patterns] of expectations) {
    for (const pattern of patterns) assert.match(strategy.summaryInstructions, pattern, strategy.id);
    assert.ok(strategy.limitations.length > 0, `${strategy.id}: documented adaptation limits`);
    assert.ok(strategy.maxSummaryTokens > 0, `${strategy.id}: bounded summary output`);
    assert.equal(strategy.summaryToolChars, ['opencode', 'pi'].includes(strategy.id) ? 2_000 : 0, `${strategy.id}: source summary tool budget`);
  }
});

test('pruning stays opt-in for OpenCode and Pi while active presets protect recent results', () => {
  assert.equal(opencode.strategy.prune.enabled, false);
  assert.equal(opencode.strategy.prune.keepRecentTurns, 2);
  assert.equal(opencode.strategy.prune.protectTokens, 40_000);
  assert.equal(opencode.strategy.prune.minSavingsTokens, 20_000);
  assert.deepEqual(opencode.strategy.prune.protectedTools, ['skill']);
  assert.equal(pi.strategy.prune.enabled, false);
  assert.equal(qwenCode.strategy.prune.enabled, true);
  assert.equal(qwenCode.strategy.prune.keepRecentTools, 5);
  assert.equal(zcode.strategy.prune.enabled, true);
  assert.equal(zcode.strategy.prune.keepRecentTools, 5);
  assert.equal(zcode.strategy.prune.groupByAssistant, true);
});
