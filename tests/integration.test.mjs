import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ToolCallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { createContextPlugin, summarizeBranch } from '../packages/core/dist/index.js';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import piPlugin from '../packages/pi/dist/index.js';
import FileSystem from '@deepseek-ai/dsh-fs';
import claudePlugin from '../packages/claude-code/dist/index.js';
import codexPlugin from '../packages/codex/dist/index.js';
import openCodePlugin from '../packages/opencode/dist/index.js';
import qwenPlugin from '../packages/qwen-code/dist/index.js';
import zcodePlugin from '../packages/zcode/dist/index.js';
import kimiPlugin from '../packages/kimi-code/dist/index.js';
import clinePlugin from '../packages/cline/dist/index.js';

import { SUMMARY, SYSTEM, seedConversation, harness, compactionEvents, assertToolPairs } from './helpers/context-harness.mjs';

test('pressure compaction records a replayable checkpoint and preserves system and recent tool messages', async t => {
  const { ctx, session, agent } = await harness(t);
  const beforeMessages = session.deriveMessages();
  const beforeTokens = ctx.tokenMeter.measure(session).totalTokens;
  const systemSeq = session.surface.nodes[0];
  const recentResult = beforeMessages.at(-1);
  const result = await ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal);

  assert.ok(result);
  assert.ok(result.shadowedSeqs.length > 0);
  assert.ok(!result.shadowedSeqs.includes(systemSeq));
  assert.ok(ctx.tokenMeter.measure(session).totalTokens < beforeTokens);
  const messages = session.deriveMessages();
  assert.deepEqual(messages[0], beforeMessages[0]);
  assert.deepEqual(messages.at(-1), recentResult);
  assert.ok(messages.some(message => message.source?.kind === 'compact-checkpoint'));
  assertToolPairs(messages);

  const events = compactionEvents(session);
  assert.deepEqual(events.map(event => event.type), ['compaction/start', 'compaction/summary', 'compaction/end']);
  assert.ok(events.every(event => event.data.compactionId === result.compactionId));
  assert.equal(events[0].data.turn, 4);
  assert.equal(events[2].data.turn, 4);
  assert.equal(events[2].data.error, undefined);
  assert.equal(events[1].data.llmStreamCall, true);
  assert.deepEqual(events[1].data.rawOutput, [{ type: 'text', text: SUMMARY }]);

  const durable = structuredClone(session.snapshotEvents());
  validateStoredEvents(session.header, durable);
  const restored = Session.create(session.id, durable, session.header, session.inheritedEventCount, ctx.sessions.messageProjections);
  assert.deepEqual(restored.deriveMessages(), messages);
  assertToolPairs(restored.deriveMessages());
});

test('Pi serializes its own tool-bounded summary input and the host retains routing and call receipts', async t => {
  const { ctx, session, agent, adapter } = await harness(t, { config: { summaryToolChars: 80 } });
  const history = session.toolHistory();
  const originalResult = session.snapshotEvents().find(event => event.type === 'tool/result');
  const originalText = originalResult.data.message.content[0].text;
  const signal = new AbortController().signal;
  await ctx.compaction.compactIfNeeded(agent, 'pressure', signal);

  assert.equal(adapter.requests.length, 1);
  const request = adapter.requests[0];
  assert.equal(request.provider, 'fixture');
  assert.equal(request.model, 'routed-model');
  assert.equal(request.purpose, 'compaction');
  assert.equal(request.sessionId, session.id);
  assert.equal(request.signal, signal);
  assert.equal(request.maxTokens, 500);
  assert.deepEqual(request.toolHistory, history);
  assert.equal(request.tools, undefined);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.match(request.messages.at(-1).content[0].text, /## Constraints & Preferences/);
  assert.match(request.messages.at(-1).content[0].text, /## Key Decisions/);
  assert.match(request.messages[0].content[0].text, /more characters truncated/);
  const receipts = session.snapshotEvents().filter(event => event.type === 'context-zoo/state');
  assert.ok(receipts.every(event => event.ignorable === true));
  assert.equal(receipts.filter(event => event.data.kind === 'model-request').length, 1);
  assert.equal(receipts.filter(event => event.data.kind === 'model-result').length, 1);
  assert.equal(session.eventAt(originalResult.seq).data.message.content[0].text, originalText);
  assert.ok(originalText.length > 80);
});

test('unsuccessful summaries leave the surface intact and release the compaction marker', async t => {
  for (const mode of ['empty', 'truncated', 'error', 'cancelled']) {
    await t.test(mode, async subtest => {
      const controller = new AbortController();
      const reason = new Error('fixture cancellation');
      const { ctx, session, agent, adapter } = await harness(subtest, {
        mode,
        onStream: mode === 'cancelled' ? () => controller.abort(reason) : undefined,
      });
      const beforeMessages = session.deriveMessages();
      const beforeNodes = [...session.surface.nodes];
      const patterns = {
        empty: /empty context summary/,
        truncated: /truncated at its output limit/,
        error: /fixture provider failure/,
        cancelled: /fixture cancellation/,
      };
      await assert.rejects(ctx.compaction.compactIfNeeded(agent, 'pressure', controller.signal), patterns[mode]);
      assert.ok(adapter.requests.length > 0);
      assert.deepEqual(session.deriveMessages(), beforeMessages);
      assert.deepEqual([...session.surface.nodes], beforeNodes);
      const events = compactionEvents(session);
      assert.deepEqual(events.map(event => event.type), ['compaction/start', 'compaction/end']);
      assert.equal(events[0].data.compactionId, events[1].data.compactionId);
      assert.equal(events[1].data.turn, 4);
      assert.ok(events[1].data.error);
    });
  }
});

test('manual compaction runs under maintenance and flushes a standalone correlated checkpoint', async t => {
  const { ctx, session, agent, adapter, maintenance } = await harness(t, { openTurn: false });
  const beforeTurns = session.snapshotEvents().filter(event => event.type === 'turn/start' || event.type === 'turn/end');
  const flushed = [];
  ctx.on('session/flush', flushedSession => {
    assert.equal(flushedSession, session);
    flushed.push(structuredClone(flushedSession.snapshotEvents()));
  });
  const sourceCommandId = CommandId('manual-fixture');
  const result = await ctx.compaction.compactNow(agent, new AbortController().signal, sourceCommandId);

  assert.ok(result);
  assert.equal(result.sourceCommandId, sourceCommandId);
  assert.deepEqual(maintenance, { calls: 1, released: 1 });
  assert.equal(adapter.requests.length, 1);
  assert.equal(flushed.length, 1);
  assert.deepEqual(session.snapshotEvents().filter(event => event.type === 'turn/start' || event.type === 'turn/end'), beforeTurns);
  const events = compactionEvents(session);
  assert.deepEqual(events.map(event => event.type), ['compaction/start', 'compaction/summary', 'compaction/end']);
  assert.equal(events[0].data.turn, null);
  assert.equal(events[2].data.turn, null);
  assert.ok(events.every(event => event.data.sourceCommandId === sourceCommandId));
  assert.ok(flushed[0].some(event => event.type === 'compaction/end' && event.data.compactionId === result.compactionId));
  const restored = Session.create(session.id, flushed[0], session.header, session.inheritedEventCount, ctx.sessions.messageProjections);
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
});

test('automatic pre-step compaction finishes before forwarding the admission decision', async t => {
  const { ctx, session, agent, adapter } = await harness(t, { config: { auto: true } });
  const messages = [createUserMessage({ content: [{ type: 'text', text: 'Continue the pending edits.' }], source: { kind: 'user' } })];
  const decision = { kind: 'enter', messages, startsRequestSeries: true };
  let nextCalls = 0;
  const result = await ctx.waterfall('agent/pre-step', {
    agent, turn: 4, step: 1, messages, signal: new AbortController().signal,
  }, async () => {
    nextCalls++;
    assert.equal(compactionEvents(session).at(-1)?.type, 'compaction/end');
    assert.ok(session.deriveMessages().some(message => message.source?.kind === 'compact-checkpoint'));
    return decision;
  });

  assert.equal(result, decision);
  assert.equal(nextCalls, 1);
  assert.equal(adapter.requests.length, 1);
  assertToolPairs(session.deriveMessages());
});

test('provider overflow bypasses the pressure threshold only within the configured retry budget', async t => {
  for (const maxOverflowRetries of [1, 0]) {
    await t.test(`retry budget ${maxOverflowRetries}`, async subtest => {
      const { ctx, session, agent, adapter } = await harness(subtest, {
        config: { auto: true, thresholdRatio: 1, maxOverflowRetries },
      });
      const signal = new AbortController().signal;
      const generation = session.surface.replaceGeneration;
      const decision = { kind: 'enter', messages: [] };
      assert.ok(ctx.tokenMeter.measure(session).totalTokens < 20_000);
      assert.equal(await ctx.waterfall('agent/pre-step', {
        agent, turn: 4, step: 1, messages: [], signal,
      }, async () => decision), decision);
      assert.equal(adapter.requests.length, 0);

      let fallbacks = 0;
      const payload = {
        agent, turn: 4, step: 1, provider: 'fixture', retryPolicy: undefined, signal,
        failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'Provider rejected the context window.' },
      };
      const fallback = async () => { fallbacks++; return undefined; };
      const action = await ctx.waterfall('agent/request-error', payload, fallback);
      if (maxOverflowRetries === 0) {
        assert.equal(action, undefined);
        assert.equal(fallbacks, 1);
        assert.equal(adapter.requests.length, 0);
        assert.equal(session.surface.replaceGeneration, generation);
      } else {
        assert.deepEqual(action, { kind: 'retry' });
        assert.equal(fallbacks, 0);
        assert.equal(adapter.requests.length, 1);
        assert.ok(session.surface.replaceGeneration > generation);
        assertToolPairs(session.deriveMessages());
        assert.equal(await ctx.waterfall('agent/request-error', payload, fallback), undefined);
        assert.equal(fallbacks, 1);
        assert.equal(adapter.requests.length, 1);
      }
    });
  }
});

test('the failure circuit stops automatic summaries until a successful manual checkpoint', async t => {
  const { ctx, session, agent, adapter, maintenance } = await harness(t, {
    mode: 'error', config: { auto: true, maxConsecutiveFailures: 1 },
  });
  const signal = new AbortController().signal;
  const decision = { kind: 'enter', messages: [] };
  const preStep = turn => ctx.waterfall('agent/pre-step', {
    agent, turn, step: 1, messages: [], signal,
  }, async () => decision);

  assert.equal(await preStep(4), decision);
  const failedRequests = adapter.requests.length;
  assert.ok(failedRequests > 0);
  assert.equal(compactionEvents(session).at(-1).type, 'compaction/end');
  assert.equal(await preStep(4), decision);
  assert.equal(adapter.requests.length, failedRequests);

  session.append('turn/end', { turn: 4, reason: { kind: 'completed' } });
  adapter.mode = 'success';
  assert.ok(await ctx.compaction.compactNow(agent, signal));
  assert.equal(adapter.requests.length, failedRequests + 1);
  assert.deepEqual(maintenance, { calls: 1, released: 1 });

  seedConversation(session, true, 5);
  assert.equal(await preStep(8), decision);
  assert.equal(adapter.requests.length, failedRequests + 2);
  assert.equal(compactionEvents(session).at(-1).data.error, undefined);
  assertToolPairs(session.deriveMessages());
});

function mechanicalPlugin(summarize, { before, branch } = {}) {
  return createContextPlugin({
    id: 'host-integration',
    create: () => ({
      async run(host) {
        const snapshot = await host.snapshot();
        const entries = snapshot.entries.filter(entry => entry.message.role !== 'system');
        before?.(host, snapshot);
        return host.compact(entries, () => summarize(host, entries));
      },
      summarizeRange: summarize,
      ...branch ? { summarizeBranch: branch } : {},
    }),
  });
}

const oneCall = async host => ({ summary: (await host.summarize({ messages: [], instruction: 'Summarize.', maxTokens: 500 })).text });

test('each auxiliary summary call is durable and a two-call transaction has no one-call receipt', async t => {
  const { ctx, session, agent } = await harness(t, { plugin: mechanicalPlugin(async host => {
    const first = await host.summarize({ messages: [], instruction: 'Earlier turns.', maxTokens: 500 });
    const second = await host.summarize({ messages: [], instruction: 'Removed turn prefix.', maxTokens: 500 });
    return { beforeSummary: [{ type: 'text', text: 'Original user constraint.' }], summary: `${first.text}\n${second.text}`, restored: [{ type: 'text', text: 'Current TODO: verify changes.' }] };
  }) });
  const result = await ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  const event = session.eventAt(result.summarySeq);
  assert.equal(event.data.llmStreamCall, undefined);
  const receipts = session.snapshotEvents().filter(event => event.type === 'context-zoo/state');
  assert.equal(receipts.filter(event => event.data.kind === 'model-request').length, 2);
  assert.equal(receipts.filter(event => event.data.kind === 'model-result').length, 2);
  assert.equal(session.eventAt(result.summarySeq + 1).type, 'user/message');
  const checkpoint = session.deriveMessages().find(message => message.source.kind === 'compact-checkpoint');
  assert.deepEqual(checkpoint.content, result.summary);
  assert.equal(checkpoint.content[0].text, 'Original user constraint.');
  assert.equal(checkpoint.content.at(-1).text, 'Current TODO: verify changes.');
  validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
});

test('an automatic transaction rejects changed history and keeps concurrent input', async t => {
  let fixture;
  const { ctx, session, agent } = fixture = await harness(t, { plugin: mechanicalPlugin(oneCall), onStream: () => {
    fixture.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'New input while summary runs.' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  } });
  await assert.rejects(ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal), /history changed/);
  assert.equal(session.deriveMessages().at(-1).content[0].text, 'New input while summary runs.');
  assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0);
  assert.equal(compactionEvents(session).at(-1).type, 'compaction/end');
});

test('manual compaction accepts context appended outside its stable selected span', async t => {
  let fixture;
  const { ctx, session, agent } = fixture = await harness(t, { openTurn: false, plugin: mechanicalPlugin(oneCall), onStream: () => {
    fixture.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'New context injection.' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  } });
  assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal));
  assert.equal(session.deriveMessages().at(-1).content[0].text, 'New context injection.');
});

test('the durable lock rejects a competing compaction while a summary is in flight', async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { ctx, session, agent } = await harness(t, { plugin: mechanicalPlugin(oneCall), onStream: async () => { enter(); await held; } });
  const pending = ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  await entered;
  await assert.rejects(ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal), /already active/);
  release();
  assert.ok(await pending);
  assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/start').length, 1);
});

test('failed recovery and expanding checkpoints never replace the selected history', async t => {
  for (const mode of ['restore-error', 'inflated']) {
    await t.test(mode, async subtest => {
      const { ctx, session, agent } = await harness(subtest, { plugin: mechanicalPlugin(async host => {
        await oneCall(host);
        if (mode === 'restore-error') throw new Error('Recovery failed');
        return { summary: 'Very long checkpoint.'.repeat(5_000) };
      }) });
      const before = session.deriveMessages();
      await assert.rejects(ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal), /Recovery failed|not smaller/);
      assert.deepEqual(session.deriveMessages(), before);
      assert.ok(compactionEvents(session).at(-1).data.error);
    });
  }
});

test('manual failures flush their closing record and preserve the caller cancellation reason', async t => {
  const controller = new AbortController();
  const reason = new Error('Caller cancelled manual operation');
  const { ctx, session, agent } = await harness(t, { openTurn: false, plugin: mechanicalPlugin(oneCall), onStream: () => controller.abort(reason) });
  let flushed = false;
  ctx.on('session/flush', () => { flushed = true; });
  await assert.rejects(ctx.compaction.compactNow(agent, controller.signal), error => error === reason);
  assert.equal(flushed, true);
  assert.equal(compactionEvents(session).at(-1).type, 'compaction/end');
});

test('branch integration calls the selected plugin under maintenance and persists its summary', async t => {
  let selected;
  const { ctx, session, agent, maintenance } = await harness(t, { openTurn: false, plugin: mechanicalPlugin(oneCall, {
    branch: async (host, entries) => { selected = entries.map(entry => entry.seq); return (await oneCall(host)).summary; },
  }) });
  const before = session.deriveMessages();
  const seqs = session.surface.nodes.slice(1, 4);
  assert.equal(await summarizeBranch(ctx, agent, seqs, new AbortController().signal), SUMMARY);
  assert.deepEqual(selected, seqs);
  assert.deepEqual(maintenance, { calls: 1, released: 1 });
  assert.deepEqual(session.deriveMessages(), before);
  const record = session.snapshotEvents().find(event => event.type === 'context-zoo/state' && event.data.kind === 'branch-summary');
  assert.equal(record.data.data.summary, SUMMARY);
  validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
});

test('all eight plugins execute their manual flow through real DSH services and survive stored-event validation', async t => {
  for (const [name, plugin] of [['claude', claudePlugin], ['codex', codexPlugin], ['opencode', openCodePlugin], ['pi', piPlugin], ['qwen', qwenPlugin], ['zcode', zcodePlugin], ['kimi', kimiPlugin], ['cline', clinePlugin]]) {
    await t.test(name, async subtest => {
      const { ctx, session, agent } = await harness(subtest, { plugin, mode: name === 'qwen' ? 'xml' : 'success', openTurn: false });
      const original = session.deriveMessages();
      assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal));
      const messages = session.deriveMessages();
      assert.deepEqual(messages[0], original[0]);
      assert.ok(messages.some(message => message.source.kind === 'compact-checkpoint'));
      assertToolPairs(messages);
      const events = structuredClone(session.snapshotEvents());
      validateStoredEvents(session.header, events);
      const restored = Session.create(session.id, events, session.header, session.inheritedEventCount, ctx.sessions.messageProjections);
      assert.deepEqual(restored.deriveMessages(), messages);
      assert.equal(events.filter(event => event.type === 'compaction/start').length, events.filter(event => event.type === 'compaction/end').length);
    });
  }
});

test('fresh file restoration uses the host filesystem and records unavailable reads', async t => {
  const reads = [];
  class FixtureFs extends FileSystem {
    async resolve(path, options) { reads.push({ path, options }); return { path }; }
    async streamText(target, signal) {
      signal.throwIfAborted();
      if (target.path === 'denied.ts') throw new Error('Permission denied by host');
      return (async function* () { yield 'CURRENT FILE '; yield 'TEXT'; })();
    }
  }
  const { ctx, session, agent } = await harness(t, { plugin: mechanicalPlugin(async host => {
    assert.equal(await host.readFile('denied.ts', 20), null);
    const content = await host.readFile('actual.ts', 9);
    return { summary: 'Checkpoint.', restored: [{ type: 'text', text: content }] };
  }) });
  await ctx.plugin(FixtureFs);
  assert.ok(await ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal));
  assert.deepEqual(reads.map(read => read.path), ['denied.ts', 'actual.ts']);
  assert.ok(reads.every(read => read.options.signal instanceof AbortSignal));
  assert.equal(session.deriveMessages().at(-1).content.at(-1).text, 'CURRENT F');
  assert.ok(session.snapshotEvents().some(event => event.type === 'context-zoo/state' && event.data.kind === 'file-unavailable' && event.data.data.path === 'denied.ts'));
});

test('source state remains available after session reconstruction', async t => {
  const plugin = mechanicalPlugin(oneCall, { before(host) { host.record('counter', { value: (host.records('counter').at(-1)?.value ?? 0) + 1 }); } });
  const { ctx, session, agent } = await harness(t, { plugin, openTurn: false });
  await ctx.compaction.compactNow(agent, new AbortController().signal);
  const restored = Session.create(session.id, structuredClone(session.snapshotEvents()), session.header, session.inheritedEventCount, ctx.sessions.messageProjections);
  let observed;
  const observing = createContextPlugin({ id: 'host-integration', create: () => ({
    async run(host) { observed = host.records('counter').at(-1)?.value; return null; },
    summarizeRange: oneCall,
  }) });
  const another = await harness(t, { plugin: observing, openTurn: false });
  another.agent.session = restored;
  assert.equal(await another.ctx.compaction.compactNow(another.agent, new AbortController().signal), null);
  assert.equal(observed, 1);
});

test('each pipeline can compact again after a mid-history system update without removing it', async t => {
  for (const [name, plugin] of [['claude', claudePlugin], ['codex', codexPlugin], ['opencode', openCodePlugin], ['pi', piPlugin], ['qwen', qwenPlugin], ['zcode', zcodePlugin], ['kimi', kimiPlugin], ['cline', clinePlugin]]) {
    await t.test(name, async subtest => {
      const { ctx, session, agent } = await harness(subtest, { plugin, mode: name === 'qwen' ? 'xml' : 'success', openTurn: false });
      const firstSystem = session.surface.nodes[0];
      session.append('turn/start', { turn: 4 });
      session.append('step/start', { turn: 4, step: 1 });
      const update = session.append('system/message', { turn: 4, step: 1, message: createSystemMessage('Updated workspace instructions must stay available.') }, { surfaceOp: 'append' });
      session.append('step/end', { turn: 4, step: 1 });
      session.append('turn/end', { turn: 4, reason: { kind: 'completed' } });
      seedConversation(session, false, 5);
      let reachedLaterHistory = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await ctx.compaction.compactNow(agent, new AbortController().signal);
        if (!result) break;
        assert.ok(!result.shadowedSeqs.includes(update.seq));
        assert.ok(!result.shadowedSeqs.includes(firstSystem));
        if (result.shadowedSeqs.some(seq => seq > update.seq && session.eventAt(seq).type === 'assistant/message')) { reachedLaterHistory = true; break; }
      }
      assert.equal(reachedLaterHistory, true, `${name} must reach history after the protected update`);
      assert.ok(session.surface.nodes.includes(update.seq));
      assert.ok(session.surface.nodes.includes(firstSystem));
      validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
      assertToolPairs(session.deriveMessages());
    });
  }
});

test('an unpatched active Session class is refused before writing user history', async t => {
  const { ctx, session, agent } = await harness(t, { plugin: mechanicalPlugin(oneCall), openTurn: false });
  class UnpatchedSession {
    static create(id) {
      const probe = Session.create(id);
      const append = probe.append.bind(probe);
      probe.append = (type, data) => append(type, data);
      return probe;
    }
  }
  Object.defineProperty(session, 'constructor', { value: UnpatchedSession });
  const before = session.snapshotEvents();
  await assert.rejects(ctx.compaction.compactNow(agent, new AbortController().signal), /active DSH Session implementation needs/);
  assert.deepEqual(session.snapshotEvents(), before);
});

test('a recovered auxiliary failure does not masquerade as a single model call', async t => {
  let fixture;
  let attempt = 0;
  const plugin = mechanicalPlugin(async host => {
    try { await oneCall(host); } catch (error) { assert.match(error.message, /fixture provider failure/); }
    return oneCall(host);
  });
  const { ctx, session, agent } = fixture = await harness(t, { plugin, onStream: () => { fixture.adapter.mode = ++attempt === 1 ? 'error' : 'success'; } });
  const result = await ctx.compaction.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.equal(session.eventAt(result.summarySeq).data.llmStreamCall, undefined);
  const receipts = session.snapshotEvents().filter(event => event.type === 'context-zoo/state');
  assert.equal(receipts.filter(event => event.data.kind === 'model-request').length, 2);
  assert.ok(receipts.some(event => event.data.kind === 'model-error'));
});

test('Codex pre-step compaction keeps system context in its logged summary request', async t => {
  const { ctx, session, agent, adapter } = await harness(t, {
    plugin: codexPlugin,
    config: { auto: true, summarizationProvider: 'summary-fixture', summarizationModel: 'checkpoint-model' },
  });
  const original = session.deriveMessages();
  const decision = { kind: 'enter', messages: [] };
  const result = await ctx.waterfall('agent/pre-step', {
    agent, turn: 4, step: 1, messages: [], signal: new AbortController().signal,
  }, async () => {
    assert.equal(compactionEvents(session).at(-1)?.type, 'compaction/end');
    return decision;
  });
  assert.equal(result, decision);
  assert.equal(adapter.requests.length, 1);
  const request = adapter.requests[0];
  assert.equal(request.provider, 'summary-fixture');
  assert.equal(request.model, 'checkpoint-model');
  assert.equal(request.tools, undefined);
  assert.ok(request.messages.some(message => message.role === 'system' && message.content[0].text === SYSTEM));
  assert.ok(request.messages.some(message => message.role === 'tool'));
  assert.deepEqual(session.deriveMessages()[0], original[0]);
  assertToolPairs(session.deriveMessages());
  const durable = structuredClone(session.snapshotEvents());
  validateStoredEvents(session.header, durable);
  assert.ok(durable.some(event => event.type === 'context-zoo/state' && event.data.plugin === 'codex' && event.data.kind === 'model-request'));
});

test('Codex retained user input survives restoration and another compaction', async t => {
  const { ctx, session, agent } = await harness(t, { plugin: codexPlugin, openTurn: false, config: { keepRecentTokens: 20_000 } });
  assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal));
  const durable = structuredClone(session.snapshotEvents());
  validateStoredEvents(session.header, durable);
  const continued = await harness(t, { plugin: codexPlugin, seed: durable, config: { keepRecentTokens: 20_000 } });
  const restored = continued.session;
  seedConversation(restored, false, 4);
  assert.ok(await continued.ctx.compaction.compactNow(continued.agent, new AbortController().signal));
  const content = restored.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
  for (let turn = 1; turn <= 6; turn++) assert.ok(content.includes(`Request ${turn}:`), `retained user input ${turn}`);
  const events = structuredClone(restored.snapshotEvents());
  validateStoredEvents(restored.header, events);
  const reloaded = Session.create(restored.id, events, restored.header, restored.inheritedEventCount, ctx.sessions.messageProjections);
  assert.deepEqual(reloaded.deriveMessages(), restored.deriveMessages());
});

test('Codex summary failure leaves the selected history unchanged', async t => {
  for (const mode of ['empty', 'truncated', 'error']) {
    await t.test(mode, async subtest => {
      const { ctx, session, agent, adapter } = await harness(subtest, {
        plugin: codexPlugin, mode, openTurn: false, config: { maxSummaryAttempts: 1, summaryRetryDelayMs: 0 },
      });
      const original = session.deriveMessages();
      await assert.rejects(ctx.compaction.compactNow(agent, new AbortController().signal));
      assert.equal(adapter.requests.length, 1);
      assert.deepEqual(session.deriveMessages(), original);
      assert.equal(compactionEvents(session).at(-1).type, 'compaction/end');
      validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
    });
  }
});

test('Codex delegates ordinary request overflow to the host without a compaction retry', async t => {
  const { ctx, session, agent, adapter } = await harness(t, { plugin: codexPlugin, config: { auto: true } });
  const original = session.snapshotEvents();
  for (const failure of [
    { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'Context window exceeded.' },
    { code: 'REQUEST_TOO_LARGE', status: 413, message: 'Request too large.' },
  ]) {
    let delegated = false;
    const result = await ctx.waterfall('agent/request-error', {
      agent, turn: 4, step: 1, provider: 'fixture', retryPolicy: undefined,
      signal: new AbortController().signal, failure,
    }, async () => { delegated = true; return undefined; });
    assert.equal(result, undefined);
    assert.equal(delegated, true);
  }
  assert.equal(adapter.requests.length, 0);
  assert.deepEqual(session.snapshotEvents(), original);
});


test('Codex explicit range checkpoints retain user input after restore and another compaction', async t => {
  const { ctx, session, agent } = await harness(t, { plugin: codexPlugin, config: { keepRecentTokens: 20_000 } });
  const start = session.surface.nodes.find(seq => session.deriveEventMessage(session.eventAt(seq))?.role === 'user');
  const end = session.surface.nodes.at(-1);
  assert.ok(await ctx.compaction.compactRegion(start, end, agent, new AbortController().signal));
  session.append('turn/end', { turn: 4, reason: { kind: 'completed' } });
  const durable = structuredClone(session.snapshotEvents());
  validateStoredEvents(session.header, durable);
  const continued = await harness(t, { plugin: codexPlugin, seed: durable, config: { keepRecentTokens: 20_000 } });
  const restored = continued.session;
  seedConversation(restored, false, 5);
  assert.ok(await continued.ctx.compaction.compactNow(continued.agent, new AbortController().signal));
  const content = restored.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
  for (const turn of [1, 2, 3, 5, 6, 7]) assert.ok(content.includes(`Request ${turn}:`), `retained user input ${turn}`);
  validateStoredEvents(restored.header, structuredClone(restored.snapshotEvents()));
});
