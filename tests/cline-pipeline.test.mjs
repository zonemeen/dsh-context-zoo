import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline, estimateTokens } from '../packages/cline/dist/pipeline.js';
import clinePlugin from '../packages/cline/dist/index.js';
import { harness, compactionEvents } from './helpers/context-harness.mjs';

function entry(seq, role, text = '', options = {}) {
  const { usage, finish, ...message } = options;
  return {
    seq, time: 0, tokens: Math.ceil(Buffer.byteLength(text) / 4),
    ...(usage === undefined ? {} : { usage }), ...(finish === undefined ? {} : { finish }),
    message: {
      id: `message-${seq}`, role,
      source: role === 'assistant' ? { kind: 'model', provider: 'fixture', model: 'model' }
        : role === 'system' || role === 'developer' ? { kind: 'system-prompt' } : { kind: 'user' },
      content: [{ type: 'text', text }], ...message,
    },
  };
}

function toolRound(seq, id, output = 'Tool result '.repeat(500)) {
  return [
    entry(seq, 'assistant', '', { content: [{ type: 'tool-call', id, name: 'read_file', arguments: '{"path":"/project/main.ts"}' }] }),
    entry(seq + 1, 'tool', output, { toolCallId: id, source: { kind: 'tool', callId: id } }),
  ];
}

function fixture(entries, options = {}) {
  const state = {
    entries: structuredClone(entries), archive: structuredClone(entries),
    contextWindow: 100_000, maxOutputTokens: 16_384, provider: 'fixture', model: 'model',
    tools: [], measuredTokens: 999_999, now: 1_000, cwd: '/project', sessionId: 'session',
    requestSeries: 'request-1', turnKey: 'turn-1', ...options.snapshot,
  };
  const requests = [];
  const commits = [];
  const saved = new Map();
  const controller = new AbortController();
  const host = {
    signal: controller.signal,
    async snapshot() { return { ...state }; },
    async summarize(request) {
      requests.push(structuredClone(request));
      const value = await options.respond?.(request, requests.length);
      const text = value?.text ?? 'Completed the initial investigation. Continue with the latest request.';
      return {
        text, content: [{ type: 'text', text }], provider: 'fixture', model: 'model',
        maxTokens: request.maxTokens, finish: 'stop', ...value,
      };
    },
    replace() { assert.fail('Compaction must preserve live history until its checkpoint commits'); },
    async compact(selected, summarize) {
      assert.ok(selected.length > 0);
      assert.ok(selected.every(value => !['system', 'developer'].includes(value.message.role)));
      const before = structuredClone(state.entries);
      const output = await summarize();
      controller.signal.throwIfAborted();
      assert.deepEqual(state.entries, before);
      const first = state.entries.findIndex(value => value.seq === selected[0].seq);
      assert.deepEqual(state.entries.slice(first, first + selected.length).map(value => value.seq), selected.map(value => value.seq));
      const compactionId = `compaction-${commits.length + 1}`;
      const seq = Math.max(0, ...state.archive.map(value => value.seq), ...state.entries.map(value => value.seq)) + 1;
      const replacement = entry(seq, 'user', output.summary, {
        source: { kind: 'compact-checkpoint', compactionId },
        content: [...(output.beforeSummary ?? []), { type: 'text', text: output.summary }, ...(output.restored ?? [])],
      });
      state.entries.splice(first, selected.length, replacement);
      state.archive.push(replacement);
      commits.push({ selected: structuredClone(selected), output });
      return { compactionId, summary: replacement.message.content, shadowedSeqs: selected.map(value => value.seq) };
    },
    async readFile() { assert.fail('Context compaction should not reload workspace files'); },
    record(kind, data) { saved.set(kind, [...(saved.get(kind) ?? []), structuredClone(data)]); },
    records(kind) { return saved.get(kind) ?? []; },
  };
  return { host, state, requests, commits, controller };
}

const joined = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
const transcript = request => request.messages.map(message => joined(message.content)).join('\n');
const history = () => [
  entry(1, 'user', 'Inspect the original implementation.'),
  entry(2, 'assistant', 'Investigation details '.repeat(800)),
  entry(3, 'user', 'Now implement the next step without changing the public API.'),
  entry(4, 'assistant', 'The current implementation is in progress.'),
];

// The local estimate deliberately differs from measuredTokens in every fixture.
test('Cline pressure uses the provider input limit or the context fallback and permits manual compaction', async () => {
  for (const [snapshot, config, expected] of [
    [{ contextWindow: 10_000, inputLimit: 4_000 }, {}, 1],
    [{ contextWindow: 10_000 }, {}, 0],
    [{ contextWindow: 10_000, inputLimit: 100_000 }, {}, 0],
  ]) {
    const state = fixture(history(), { snapshot });
    await createPipeline({ keepRecentTokens: 0, ...config }).run(state.host, 'pressure');
    assert.equal(state.commits.length, expected);
  }
  const manual = fixture(history());
  assert.ok(await createPipeline({ auto: false, keepRecentTokens: 0 }).run(manual.host, 'manual'));
});

test('Cline caps provider calibration and ignores usage predating a live checkpoint', async () => {
  const small = [entry(1, 'user', 'Original task'), entry(2, 'assistant', 'a'.repeat(1_000), {
    usage: { inputTokens: 1_000_000, outputTokens: 1 },
  }), entry(3, 'user', 'Continue'), entry(4, 'assistant', 'Pending')];
  const capped = fixture(small, { snapshot: { contextWindow: 10_000 } });
  assert.equal(await createPipeline({ keepRecentTokens: 0 }).run(capped.host, 'pressure'), null);
  assert.equal(capped.requests.length, 0);

  const stale = fixture([
    entry(100, 'user', 'Previous compact checkpoint', { source: { kind: 'compact-checkpoint', compactionId: 'previous' } }),
    entry(20, 'assistant', 'a'.repeat(10_000), { usage: { inputTokens: 1_000_000, outputTokens: 1 } }),
    entry(101, 'user', 'Continue'), entry(102, 'assistant', 'Pending'),
  ], { snapshot: { contextWindow: 10_000 } });
  assert.equal(await createPipeline({ keepRecentTokens: 0 }).run(stale.host, 'pressure'), null);
  assert.equal(stale.requests.length, 0);
});

test('Cline calibrates against disjoint cached input once and excludes output usage', async () => {
  const entries = [entry(1, 'user', 'u'.repeat(4_000)), entry(2, 'assistant', 'a'.repeat(100), {
    usage: { inputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 9_000_000, totalTokens: 9_002_100 },
  }), entry(3, 'user', 'Continue'), entry(4, 'assistant', 'Pending')];
  for (const [contextWindow, expected] of [[2_000, 1], [3_200, 0]]) {
    const state = fixture(entries, { snapshot: { contextWindow } });
    await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'pressure');
    assert.equal(state.commits.length, expected);
  }
});

test('Cline sends one serialized user transcript with prior checkpoints, bounded tool text, and no tools', async () => {
  const entries = [
    entry(0, 'system', 'Persistent instructions'),
    entry(1, 'user', 'A previous checkpoint with unresolved work', { source: { kind: 'compact-checkpoint', compactionId: 'previous' } }),
    entry(2, 'user', 'Investigate the initial request'),
    ...toolRound(3, 'read-1', `TOOL_START\n${'x'.repeat(10_000)}\nTOOL_END`),
    entry(5, 'assistant', '', { content: [
      { type: 'reasoning', text: 'PRIVATE_REASONING_MARKER' },
      { type: 'text', text: 'Investigation details '.repeat(800) },
    ] }),
    entry(6, 'user', 'The latest user request'), entry(7, 'assistant', 'Working'),
  ];
  const state = fixture(entries);
  await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
  assert.equal(state.requests.length, 1);
  const request = state.requests[0];
  assert.deepEqual(request.messages.map(message => message.role), ['user']);
  assert.equal(request.includeTools, false);
  assert.match(transcript(request), /A previous checkpoint with unresolved work/);
  assert.match(transcript(request), /TOOL_START/);
  assert.doesNotMatch(transcript(request), /x{2100}/);
  assert.doesNotMatch(transcript(request), /PRIVATE_REASONING_MARKER/);
  assert.equal(request.maxTokens, 8_192);
  assert.equal(state.commits.length, 1);
});

test('Cline summary output honors explicit limits and bounds its default by the active model', async () => {
  for (const [maximum, configured, expected] of [[16_384, 20_000, 20_000], [321, 2_000, 2_000], [4_000, 200, 200], [321, undefined, 321]]) {
    const state = fixture(history(), { snapshot: { maxOutputTokens: maximum } });
    await createPipeline({ keepRecentTokens: 0, maxSummaryTokens: configured }).run(state.host, 'manual');
    assert.equal(state.requests[0].maxTokens, expected);
    assert.equal(state.commits.length, 1);
  }
});

test('Cline keeps the latest real user turn whole and never separates selected tool pairs', async () => {
  const entries = [entry(1, 'user', 'Original request'), ...toolRound(2, 'old-call'),
    entry(4, 'assistant', 'Earlier investigation '.repeat(800)),
    entry(5, 'user', 'Retain this exact user message'), ...toolRound(6, 'new-call'),
    entry(8, 'assistant', 'Most recent work')];
  const state = fixture(entries);
  await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
  assert.deepEqual(state.commits[0].selected.map(value => value.seq), [1, 2, 3, 4]);
  assert.deepEqual(state.state.entries.slice(-4), entries.slice(-4));
  assert.equal(state.state.entries.find(value => value.seq === 5).message.content[0].text, 'Retain this exact user message');
});

test('Cline skips checkpoint-only spans and preserves protected instructions between compactable spans', async () => {
  const checkpoint = entry(1, 'user', 'Earlier checkpoint', { source: { kind: 'compact-checkpoint', compactionId: 'previous' } });
  const separator = entry(2, 'developer', 'Permanent updated instructions');
  const first = [entry(3, 'user', 'Older user request'), entry(4, 'assistant', 'Earlier work '.repeat(1_000))];
  const later = [entry(5, 'user', 'Latest request'), entry(6, 'assistant', 'Pending work')];
  const state = fixture([entry(0, 'system', 'Base rules'), checkpoint, separator, ...first, ...later]);
  await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
  assert.deepEqual(state.commits[0].selected.map(value => value.seq), [3, 4]);
  assert.deepEqual(state.state.entries.slice(0, 3), [entry(0, 'system', 'Base rules'), checkpoint, separator]);
  assert.deepEqual(state.state.entries.slice(-2), later);

  const split = [entry(0, 'system', 'Base rules'), entry(1, 'user', 'Original request'),
    entry(2, 'assistant', 'Completed earlier work '.repeat(1_000)),
    entry(3, 'developer', 'Permanent instructions added later'),
    entry(4, 'user', 'Latest request'), entry(5, 'assistant', 'Current work')];
  const separated = fixture(split);
  await createPipeline({ keepRecentTokens: 0 }).run(separated.host, 'manual');
  assert.deepEqual(separated.commits[0].selected.map(value => value.seq), [1, 2]);
  assert.deepEqual(separated.state.entries.slice(-3), split.slice(-3));
});

test('Cline can compact an extended initial turn while retaining its recent twenty thousand tokens', async () => {
  const entries = [entry(1, 'user', 'A long-running initial request'),
    ...Array.from({ length: 12 }, (_, index) => entry(index + 2, 'assistant', `Work ${index}: ${'a'.repeat(10_000)}`))];
  const state = fixture(entries);
  await createPipeline().run(state.host, 'manual');
  assert.equal(state.commits.length, 1);
  assert.ok(state.commits[0].selected.length < entries.length - 1);
  const retained = state.state.entries.filter(value => value.message.source.kind !== 'compact-checkpoint');
  assert.ok(retained.reduce((sum, value) => sum + estimateTokens(value), 0) >= 20_000);
  assert.deepEqual(retained.at(-1), entries.at(-1));
});

test('Cline falls back after summary failure and retains user text, recent assistant notes, and tool activity', async () => {
  const original = 'Keep this full original user instruction verbatim: preserve the exact return type.';
  const entries = [entry(1, 'user', original), entry(2, 'assistant', 'Obsolete detailed analysis '.repeat(2_000)),
    ...toolRound(3, 'read-1'), entry(5, 'assistant', 'Recent note one.'),
    entry(6, 'assistant', 'Recent note two.'), entry(7, 'assistant', 'Recent note three.'),
    entry(8, 'user', 'Latest user request'), entry(9, 'assistant', 'Working')];
  const state = fixture(entries, { respond() { throw new Error('Temporary provider failure'); } });
  assert.ok(await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual'));
  assert.equal(state.requests.length, 1);
  assert.equal(state.commits.length, 1);
  const output = state.commits[0].output;
  const summary = joined([...(output.beforeSummary ?? []), { type: 'text', text: output.summary }, ...(output.restored ?? [])]);
  assert.ok(summary.includes(original));
  assert.match(summary, /Recent note two\.[\s\S]*Recent note three\./);
  assert.match(summary, /\/project\/main\.ts/);
  assert.deepEqual(state.state.entries.slice(-2), entries.slice(-2));
});

test('Cline rejects blank, truncated, nontext, and nonshrinking summaries without changing live history', async () => {
  for (const response of [
    { text: '   ' },
    { text: 'Incomplete handoff', finish: 'max-tokens' },
    { text: 'Invalid handoff', content: [{ type: 'tool-call', id: 'unexpected', name: 'read_file', arguments: '{}' }] },
    { text: 'Larger handoff '.repeat(10_000) },
  ]) {
    const entries = history();
    const state = fixture(entries, { respond: () => response });
    const attempt = createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
    if (response.finish || response.content || response.text.length > 100_000) await assert.rejects(attempt);
    else assert.equal(await attempt, null);
    assert.equal(state.requests.length, 1);
    assert.equal(state.commits.length, 0);
    assert.deepEqual(state.state.entries, entries);
  }
});

test('Cline handles provider overflow without a summary request and persists its retry allowance', async () => {
  for (const trigger of ['context-overflow', 'request-too-large']) {
    const state = fixture([entry(1, 'user', 'Original request'),
      entry(2, 'assistant', 'Obsolete investigation '.repeat(2_000)),
      entry(3, 'assistant', 'Recent note one'), entry(4, 'assistant', 'Recent note two'),
      entry(5, 'assistant', 'Recent note three'), entry(6, 'user', 'Latest request'),
      entry(7, 'assistant', 'Current work')]);
    assert.ok(await createPipeline({ keepRecentTokens: 0 }).run(state.host, trigger));
    assert.equal(state.requests.length, 0);
    assert.equal(state.commits.length, 1);
    const previous = structuredClone(state.state.entries);
    assert.equal(await createPipeline({ keepRecentTokens: 0 }).run(state.host, trigger), null);
    assert.equal(state.commits.length, 1);
    assert.deepEqual(state.state.entries, previous);
  }
});

test('Cline cancellation prevents fallback and checkpoint commits', async () => {
  const entries = history();
  const reason = new Error('Cancelled by user');
  const state = fixture(entries, { respond() { state.controller.abort(reason); throw reason; } });
  await assert.rejects(createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual'), error => error === reason);
  assert.equal(state.requests.length, 1);
  assert.equal(state.commits.length, 0);
  assert.deepEqual(state.state.entries, entries);
});


test('Cline manual blank summaries leave real DSH history intact and release maintenance for a retry', async t => {
  const { ctx, session, agent, adapter, maintenance } = await harness(t, {
    plugin: clinePlugin, mode: 'empty', openTurn: false, config: { keepRecentTokens: 0 },
  });
  const messages = session.deriveMessages();
  const nodes = [...session.surface.nodes];
  assert.equal(await ctx.compaction.compactNow(agent, new AbortController().signal), null);
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(session.deriveMessages(), messages);
  assert.deepEqual([...session.surface.nodes], nodes);
  assert.deepEqual(compactionEvents(session).map(event => event.type), ['compaction/start', 'compaction/end']);
  assert.deepEqual(maintenance, { calls: 1, released: 1 });

  adapter.mode = 'success';
  assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal));
  assert.equal(adapter.requests.length, 2);
  assert.deepEqual(maintenance, { calls: 2, released: 2 });
});

test('Cline overflow skips an insufficient old span and spends one retry on a later viable tool span', async () => {
  const first = [entry(1, 'user', 'Initial small task'),
    entry(2, 'assistant', 'Earlier short investigation '.repeat(60)),
    entry(3, 'developer', 'Permanent instructions between tasks')];
  const entries = [...first, entry(4, 'user', 'Investigate the larger task'),
    ...toolRound(5, 'large-read-1', 'Large tool output '.repeat(5_000)),
    entry(7, 'assistant', 'Recent investigation note one'),
    ...toolRound(8, 'large-read-2', 'Large tool output '.repeat(5_000)),
    entry(10, 'assistant', 'Recent investigation note two'),
    entry(11, 'user', 'Continue with this latest request'), entry(12, 'assistant', 'Current work')];
  const state = fixture(entries, { snapshot: { contextWindow: 20_000 } });
  let attempts = 0;
  const compact = state.host.compact;
  state.host.compact = (...args) => { attempts++; return compact(...args); };

  assert.ok(await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'context-overflow'));
  assert.equal(state.requests.length, 0);
  assert.equal(attempts, 1);
  assert.equal(state.commits.length, 1);
  assert.deepEqual(state.state.entries.slice(0, 3), first);
  assert.ok(state.commits[0].selected.every(value => value.seq >= 4));
  assert.ok(state.commits[0].selected.some(value => value.seq === 6));
  assert.ok(state.commits[0].selected.some(value => value.seq === 9));
  assert.ok(state.host.records('cline/state').every(record => record.overflows === 1));
  const after = structuredClone(state.state.entries);
  assert.equal(await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'context-overflow'), null);
  assert.equal(attempts, 1);
  assert.deepEqual(state.state.entries, after);
});

test('Cline propagates wrapped and coded cancellation without an aborted host signal or fallback', async () => {
  const abort = new Error('Provider request aborted');
  abort.name = 'AbortError';
  for (const reason of [new Error('Provider request failed', { cause: abort }), { code: 'ABORTED', message: 'Request cancelled' }]) {
    const entries = [entry(1, 'user', 'Original task'),
      entry(2, 'assistant', 'Obsolete investigation '.repeat(2_000)),
      entry(3, 'assistant', 'Recent note one'), entry(4, 'assistant', 'Recent note two'),
      entry(5, 'assistant', 'Recent note three'), entry(6, 'user', 'Latest request'),
      entry(7, 'assistant', 'Current work')];
    const state = fixture(entries, { respond() { throw reason; } });
    await assert.rejects(createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual'), error => error === reason);
    assert.equal(state.controller.signal.aborted, false);
    assert.equal(state.requests.length, 1);
    assert.equal(state.commits.length, 0);
    assert.deepEqual(state.state.entries, entries);
    assert.equal(state.host.records('cline/state').length, 0);
  }
});
