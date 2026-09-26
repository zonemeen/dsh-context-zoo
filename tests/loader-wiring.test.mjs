/** Loader replacement checks using installed packages and isolated DSH scope routing. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Loader, { EntryTree, Group } from '@deepseek-ai/cordis-plugin-loader';
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { createProfilePatch } from '../scripts/create-profile-patch.mjs';
import { SummaryAdapter, seedConversation, assertToolPairs } from './helpers/context-harness.mjs';

// Cordis exposes FiberState.Active as a TypeScript const enum, without a runtime export.
const ACTIVE = 2;
const agentIds = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code'];
const nativeEngine = '@deepseek-ai/dsh-compaction-basic';
const nativePruner = '@deepseek-ai/dsh-compaction-tool-result-pruner';
const contextConfig = { auto: true, reserveTokens: 0, thresholdRatio: 0.01, keepRecentTokens: 80, maxSummaryTokens: 500 };

function nativeEntries() {
  return [
    { id: 'compaction-basic', name: nativeEngine, config: { auto: false } },
    { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    { id: 'tool-result-pruner', name: nativePruner },
  ];
}

function nativePreset() {
  return [{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', plugins: [
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true }, config: nativeEntries() },
  ] } }];
}

function selectedEntries(original, id, preset = false) {
  const warnings = [];
  const resolved = applyEntryPatches(original, createProfilePatch(original, id), (...warning) => warnings.push(warning));
  assert.deepEqual(warnings, []);
  const entries = preset ? resolved[0].config.plugins : resolved;
  const tune = rows => {
    for (const entry of rows) {
      if (entry.name === `dsh-context-${id}`) entry.config = contextConfig;
      if (entry.group) tune(entry.config);
    }
  };
  tune(entries);
  return entries;
}

class MemoryTree extends EntryTree {
  write() {}
}

async function runtime(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, TokenMeter, CommandRuntime]) await ctx.plugin(plugin);
  const adapter = new SummaryAdapter();
  ctx.llm.registerAdapter(['fixture'], adapter);
  await ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href });
  ctx.loader.builtins.group = Group;
  return { ctx, adapter };
}

async function mount(ctx, entries) {
  let tree;
  await ctx.plugin({
    name: 'loader-test-owner',
    inject: ['loader'],
    async apply(owner) {
      tree = new MemoryTree(owner);
      owner.effect(() => () => tree.root.stop());
      await tree.root.update(structuredClone(entries));
      await tree.await();
    },
  });
  const pending = [...tree.entries()].filter(entry => !entry.disabled && entry.fiber?.state !== ACTIVE);
  assert.deepEqual(pending.map(entry => entry.options.name), [], 'Every active package must finish loading.');
  return tree;
}

function engineEntry(tree, name) {
  const matches = [...tree.entries()].filter(entry => entry.options.name === name && !entry.disabled);
  assert.equal(matches.length, 1);
  return matches[0];
}

function assertReplacement(tree, id) {
  const entries = [...tree.entries()];
  const native = entries.filter(entry => [nativeEngine, nativePruner].includes(entry.options.name));
  assert.ok(native.every(entry => entry.disabled && entry.fiber === undefined));
  const selected = engineEntry(tree, `dsh-context-${id}`);
  assert.ok(selected.ctx.get('compaction'));
  assert.ok(!(selected.ctx.get('compaction') instanceof BasicCompactionEngine));
  assert.equal(selected.ctx.get('toolResultPruner'), undefined);
  return selected.ctx;
}

function agentFor(ctx, label, parentKey) {
  const session = ctx.sessions.create(SessionId(label));
  seedConversation(session, false);
  const agent = {
    session,
    options: { provider: 'fixture', model: 'routed-model' },
    async runMaintenance(task) { return task(new AbortController().signal); },
  };
  if (parentKey !== undefined) agent.ctx = createScope(ctx, agent, { parent: parentKey }).ctx;
  else agent.ctx = ctx;
  return agent;
}

function assertDurableOwner(ctx, agent, id) {
  const events = structuredClone(agent.session.snapshotEvents());
  const owners = new Set(events.filter(event => event.type === 'context-zoo/state').map(event => event.data.plugin));
  assert.deepEqual([...owners], [id]);
  assert.equal(events.filter(event => event.type === 'compaction/summary').length, 1);
  assert.ok(agent.session.surface.replaceGeneration > 0);
  assertToolPairs(agent.session.deriveMessages());
  validateStoredEvents(agent.session.header, events);
  const restored = Session.create(agent.session.id, events, agent.session.header, agent.session.inheritedEventCount, ctx.sessions.messageProjections);
  assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages());
}

async function exercise(ctx, adapter, id, parentKey) {
  adapter.mode = id === 'qwen-code' ? 'xml' : 'success';
  const manual = agentFor(ctx, `${id}-manual`, parentKey);
  const execution = await ctx.commands.execute(manual, '/compact', [], new AbortController().signal);
  assert.equal(execution?.result.kind, 'success');
  assert.match(execution.result.text, /^Compacted /);
  assertDurableOwner(ctx, manual, id);
  const automatic = agentFor(ctx, `${id}-pressure`, parentKey);
  automatic.session.append('turn/start', { turn: 4 });
  const before = adapter.requests.length;
  const decision = await ctx.waterfall(scopeTarget(automatic, parentKey === undefined ? undefined : automatic), 'agent/pre-step', {
    agent: automatic, signal: new AbortController().signal,
  }, async () => ({ kind: 'continue' }));
  assert.deepEqual(decision, { kind: 'continue' });
  assert.ok(adapter.requests.length > before);
  assertDurableOwner(ctx, automatic, id);
}

test('the unmodified Loader composition provides the actual native engine and pruner', async t => {
  const { ctx } = await runtime(t);
  const tree = await mount(ctx, nativeEntries());
  assert.ok(engineEntry(tree, nativeEngine).ctx.get('compaction') instanceof BasicCompactionEngine);
  assert.ok(ctx.toolResultPruner instanceof ToolResultPruner);
});

for (const id of agentIds) {
  test(`${id}: generated headless overlay replaces the native Loader provider`, async t => {
    const { ctx, adapter } = await runtime(t);
    const tree = await mount(ctx, selectedEntries(nativeEntries(), id));
    assertReplacement(tree, id);
    await exercise(ctx, adapter, id);
  });
}

test('seven simultaneously mounted preset scopes dispatch only to their selected context engine', async t => {
  const { ctx, adapter } = await runtime(t);
  const presets = [];
  for (const id of agentIds) {
    const key = {};
    const scope = createScope(ctx, key);
    const tree = await mount(scope.ctx, selectedEntries(nativePreset(), id, true));
    presets.push({ id, key, tree, engineCtx: assertReplacement(tree, id) });
  }
  assert.equal(ctx.get('compaction'), undefined, 'Preset implementations must remain in their isolated realms.');
  assert.equal(ctx.get('toolResultPruner'), undefined);
  assert.equal(new Set(presets.map(preset => preset.engineCtx.get('compaction'))).size, agentIds.length);
  for (const preset of presets) {
    await t.test(preset.id, () => exercise(ctx, adapter, preset.id, preset.key));
  }
});
