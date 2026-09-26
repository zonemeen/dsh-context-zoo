import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approximateTokens, contextTokens, createPipeline, estimateTokens,
  retainUserMessages, summaryPrefix, truncateTokens,
} from '../packages/codex/dist/pipeline.js';

function entry(seq, role, text = '', options = {}) {
  const source = role === 'assistant'
    ? { kind: 'model', provider: 'fixture', model: 'model' }
    : role === 'system' ? { kind: 'system-prompt' } : { kind: 'user' };
  const { usage, finish, ...message } = options;
  return {
    seq, time: 0, tokens: Math.ceil(Buffer.byteLength(text) / 4),
    ...(usage === undefined ? {} : { usage }), ...(finish === undefined ? {} : { finish }),
    message: { id: `message-${seq}`, role, source, content: [{ type: 'text', text }], ...message },
  };
}

function toolRound(seq, id, output = 'tool output '.repeat(200)) {
  return [
    entry(seq, 'assistant', '', { content: [{ type: 'tool-call', id, name: 'read_file', arguments: '{"path":"/file.ts"}' }] }),
    entry(seq + 1, 'tool', output, { toolCallId: id, source: { kind: 'tool', callId: id } }),
  ];
}

function snapshot(entries, extra = {}) {
  return {
    entries, archive: entries, contextWindow: 100_000, maxOutputTokens: 4_000,
    provider: 'fixture', model: 'model', tools: [], measuredTokens: 999_999,
    now: 1_000, cwd: '/project', sessionId: 'session', requestSeries: 'request-1', turnKey: 'turn-1',
    ...extra,
  };
}

function fixture(entries, options = {}) {
  const state = snapshot(structuredClone(entries), options.snapshot);
  state.archive = structuredClone(options.archive ?? entries);
  const requests = [];
  const commits = [];
  const records = new Map();
  const controller = new AbortController();
  let nextSeq = Math.max(0, ...state.archive.map(value => value.seq)) + 1;
  const host = {
    signal: controller.signal,
    async snapshot() { return { ...state }; },
    async summarize(request) {
      requests.push(structuredClone(request));
      const value = await options.respond?.(request, requests.length);
      const text = value?.text ?? 'Continue the pending implementation.';
      return {
        text, content: [{ type: 'text', text }], provider: 'fixture', model: 'model',
        maxTokens: request.maxTokens, finish: 'stop', ...value,
      };
    },
    replace() { assert.fail('Codex local compaction must preserve live history until its checkpoint commits'); },
    async compact(selected, summarize) {
      assert.ok(selected.every(value => !['system', 'developer'].includes(value.message.role)));
      const before = structuredClone(state.entries);
      const output = await summarize();
      controller.signal.throwIfAborted();
      assert.deepEqual(state.entries, before);
      const first = state.entries.findIndex(value => value.seq === selected[0].seq);
      assert.deepEqual(state.entries.slice(first, first + selected.length).map(value => value.seq), selected.map(value => value.seq));
      const compactionId = `compaction-${commits.length + 1}`;
      nextSeq = Math.max(nextSeq, ...state.archive.map(value => value.seq + 1), ...state.entries.map(value => value.seq + 1));
      const replacement = entry(nextSeq++, 'user', output.summary, {
        source: { kind: 'compact-checkpoint', compactionId },
        content: [...(output.beforeSummary ?? []), { type: 'text', text: output.summary }, ...(output.restored ?? [])],
      });
      state.entries.splice(first, selected.length, replacement);
      state.archive.push(replacement);
      commits.push({ selected: structuredClone(selected), output });
      return { compactionId, summary: replacement.message.content, shadowedSeqs: selected.map(value => value.seq) };
    },
    async readFile() { assert.fail('Codex local compaction does not reload workspace files'); },
    record(kind, data) { records.set(kind, [...(records.get(kind) ?? []), structuredClone(data)]); },
    records(kind) { return records.get(kind) ?? []; },
  };
  return { host, state, requests, commits, controller };
}

const text = value => ({ type: 'text', text: value });
const joined = blocks => blocks.map(block => block.type === 'text' ? block.text : '').join('');
const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1_000_000, width: 600, height: 400 } };
const largeHistory = () => [entry(1, 'user', 'Original request '.repeat(250)), entry(2, 'assistant', 'Completed work '.repeat(800))];

test('Codex counts UTF-8 content once per message and excludes plaintext reasoning', () => {
  assert.equal(approximateTokens('abcd'), 1);
  assert.equal(approximateTokens('abcde'), 2);
  assert.equal(approximateTokens('你好'), 2);
  assert.equal(estimateTokens(entry(1, 'user', '', { content: [text('a'), text('b')] })), 1);
  assert.equal(estimateTokens(entry(2, 'assistant', '', { content: [text('a'), { type: 'reasoning', text: 'r'.repeat(100_000) }] })), 1);
  assert.equal(estimateTokens(entry(3, 'user', '', { content: [image] })), 1_844);
  assert.equal(estimateTokens(entry(4, 'user', '', { content: [image, image] })), 3_687);
});

test('Codex middle truncation preserves UTF-8 characters and reports the omitted nominal token count', () => {
  assert.equal(truncateTokens('abcdefghijklmno', 2), 'abcd…2 tokens truncated…lmno');
  assert.equal(truncateTokens('前'.repeat(6), 2), '前…3 tokens truncated…前');
  assert.equal(truncateTokens('你好', 0), '…2 tokens truncated…');
  assert.equal(truncateTokens('', 0), '');
  assert.equal(truncateTokens('abcd', 1), 'abcd');
});

test('Codex retains the newest users in original order with one partial older message', () => {
  const messages = [[text('too old')], [text('0123456789')], [text('ab'), text('cd')]];
  const retained = retainUserMessages(messages, 2);
  assert.deepEqual(retained, [[text('01…2 tokens truncated…89')], [text('ab'), text('cd')]]);
  assert.deepEqual(retainUserMessages(messages, 0), []);
});

test('Codex retains media-only and mixed users as text without reattaching images', () => {
  assert.deepEqual(retainUserMessages([[image], [text('first'), image, text('second')]], 100), [
    [text('')], [text('firstsecond')],
  ]);
});

test('Codex triggers at 90 percent inclusive without reserving the model output limit', async () => {
  for (const [tokens, expected] of [[899, 0], [900, 1]]) {
    const state = fixture([entry(1, 'user', 'x'.repeat((tokens - 1) * 4)), entry(2, 'assistant', 'work')], {
      snapshot: { contextWindow: 1_000, maxOutputTokens: 990 },
    });
    await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'pressure');
    assert.equal(state.commits.length, expected);
  }
});

test('Codex pressure estimates include protected instructions and UTF-8 byte costs', async () => {
  const state = fixture([
    entry(0, 'system', '中'.repeat(666)), entry(1, 'user', 'u'.repeat(800)), entry(2, 'assistant', 'a'.repeat(800)),
  ], { snapshot: { contextWindow: 1_000 } });
  await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'pressure');
  assert.equal(state.commits.length, 1);
  assert.equal(state.state.entries[0].message.role, 'system');
});

test('Codex uses authoritative totals and otherwise sums disjoint cache counters exactly once', () => {
  const usage = { totalTokens: 400, inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 50 };
  const entries = [entry(1, 'user', 'earlier '.repeat(1_000)), entry(2, 'assistant', 'reply', { usage }), entry(3, 'user', 'more')];
  assert.equal(contextTokens(snapshot(entries)), 401);
  const { totalTokens, ...disjointUsage } = usage;
  const disjoint = [...entries];
  disjoint[1] = { ...entries[1], usage: disjointUsage };
  assert.equal(contextTokens(snapshot(disjoint)), 401);
});

test('Codex ignores stale and failed usage after a checkpoint changes the request history', () => {
  const entries = [
    entry(100, 'user', 'checkpoint', { source: { kind: 'compact-checkpoint', compactionId: 'earlier' } }),
    entry(20, 'assistant', 'reply', { usage: { totalTokens: 999_999, inputTokens: 999_999, outputTokens: 0 } }),
    entry(101, 'user', 'more'),
  ];
  assert.equal(contextTokens(snapshot(entries)), entries.reduce((total, value) => total + estimateTokens(value), 0));
  const failed = [entry(1, 'user', 'task'), entry(2, 'assistant', 'error', { usage: { inputTokens: 999_999, outputTokens: 0 }, finish: 'error' })];
  assert.equal(contextTokens(snapshot(failed)), failed.reduce((total, value) => total + estimateTokens(value), 0));
});

test('Codex summary input contains protected instructions and selected history with no declared tools', async () => {
  const system = entry(0, 'system', 'Persistent base instructions');
  const developer = entry(1, 'developer', 'Developer constraint');
  const conversation = [entry(2, 'user', 'real request '.repeat(200)), ...toolRound(3, 'call-1'), entry(5, 'assistant', 'result '.repeat(500))];
  const state = fixture([system, developer, ...conversation]);
  await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
  assert.deepEqual(state.requests[0].messages.map(message => message.role), ['system', 'developer', 'user', 'assistant', 'tool', 'assistant']);
  assert.match(joined(state.requests[0].messages[0].content), /Persistent base instructions/);
  assert.match(joined(state.requests[0].messages[4].content), /tool output/);
  assert.equal(state.requests[0].includeTools, false);
  assert.match(state.requests[0].instruction, /handoff/);
  assert.deepEqual(state.commits[0].selected.map(value => value.seq), conversation.map(value => value.seq));
});

test('Codex distinguishes injected context from retained real users and excludes prior summaries', async () => {
  const entries = [
    entry(1, 'user', 'First actual user request.'),
    entry(2, 'user', 'Workspace context only', { source: { kind: 'workspace-context', form: 'snapshot' } }),
    entry(3, 'user', `${summaryPrefix}\nPrevious summary must not become a retained user.`),
    entry(4, 'user', 'Latest actual user request.'),
    entry(5, 'assistant', 'work '.repeat(2_000)),
  ];
  const state = fixture(entries);
  await createPipeline().run(state.host, 'manual');
  const { output } = state.commits[0];
  const retained = joined(output.beforeSummary ?? []);
  assert.match(retained, /First actual user request\.[\s\S]*Latest actual user request\./);
  assert.doesNotMatch(retained, /Previous summary must not become/);
  assert.equal((retained.match(/\[Retained user message \d+\]/g) ?? []).length, 2);
  assert.match(retained, /Workspace context only[\s\S]*\[Retained user message 2\]Latest actual user request/);
  assert.ok(output.summary.startsWith(`${summaryPrefix}\n`));
  const blocks = state.state.entries[0].message.content;
  assert.ok(blocks.findIndex(block => block.text === output.summary) > blocks.findIndex(block => block.text === 'Latest actual user request.'));
});

test('Codex preserves protected updates and advances to subsequent compactable spans', async () => {
  const system = entry(0, 'system', 'Base rules');
  const update = entry(3, 'developer', 'Updated permanent rules');
  const entries = [system, ...largeHistory(), update, entry(4, 'user', 'Second request '.repeat(250)), entry(5, 'assistant', 'Second work '.repeat(800))];
  const state = fixture(entries);
  await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
  await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
  assert.deepEqual(state.commits.map(commit => commit.selected.map(value => value.seq)), [[1, 2], [4, 5]]);
  assert.deepEqual(state.state.entries.filter(value => [0, 3].includes(value.seq)), [system, update]);
});

test('Codex summary overflow drops oldest complete tool exchanges and keeps the live selection intact', async () => {
  const entries = [entry(0, 'system', 'Base rules'), ...toolRound(1, 'old-call'), entry(3, 'user', 'Current task'), entry(4, 'assistant', 'work '.repeat(1_000))];
  const state = fixture(entries, { respond(_request, count) { if (count === 1) throw new Error('context window exceeded'); } });
  await createPipeline({ keepRecentTokens: 0, summaryRetryDelayMs: 0 }).run(state.host, 'manual');
  assert.equal(state.requests.length, 2);
  const retried = state.requests[1].messages;
  assert.equal(retried[0].role, 'system');
  assert.ok(retried.every(message => message.role !== 'tool'));
  assert.ok(retried.every(message => message.content.every(block => block.type !== 'tool-call')));
  assert.deepEqual(state.commits[0].selected.map(value => value.seq), [1, 2, 3, 4]);
});

test('Codex resets transient retry allowance after overflow removes an old item', async () => {
  const state = fixture(largeHistory(), { respond(_request, count) {
    if (count === 1 || count === 3) throw new Error('temporary connection failure');
    if (count === 2) throw new Error('context window exceeded');
  } });
  await createPipeline({ keepRecentTokens: 0, maxSummaryAttempts: 2, summaryRetryDelayMs: 0 }).run(state.host, 'manual');
  assert.equal(state.requests.length, 4);
  assert.equal(state.commits.length, 1);
  assert.ok(state.requests[2].messages.length < state.requests[1].messages.length);
});

test('Codex stops after retry exhaustion without committing any history', async () => {
  const entries = largeHistory();
  const state = fixture(entries, { respond() { throw new Error('transport disconnected'); } });
  await assert.rejects(createPipeline({ maxSummaryAttempts: 2, summaryRetryDelayMs: 0 }).run(state.host, 'manual'), /transport disconnected/);
  assert.equal(state.requests.length, 2);
  assert.equal(state.commits.length, 0);
  assert.deepEqual(state.state.entries, entries);
});

test('Codex abort during summary prevents retries, checkpoint records, and commit', async () => {
  const entries = largeHistory();
  const reason = new Error('cancelled by user');
  const state = fixture(entries, { respond() { state.controller.abort(reason); throw reason; } });
  await assert.rejects(createPipeline({ summaryRetryDelayMs: 0 }).run(state.host, 'manual'), error => error === reason);
  assert.equal(state.requests.length, 1);
  assert.equal(state.commits.length, 0);
  assert.equal(state.host.records('codex/checkpoint').length, 0);
  assert.deepEqual(state.state.entries, entries);
});

test('Codex rejects empty, truncated, and tool-calling summaries without retrying or committing', async () => {
  for (const response of [{ text: '   ' }, { text: 'incomplete', finish: 'max-tokens' }, { text: 'invalid', content: [{ type: 'tool-call', id: 'unexpected', name: 'read_file', arguments: '{}' }] }]) {
    const entries = largeHistory();
    const state = fixture(entries, { respond: () => response });
    await assert.rejects(createPipeline({ summaryRetryDelayMs: 0 }).run(state.host, 'manual'));
    assert.equal(state.requests.length, 1);
    assert.equal(state.commits.length, 0);
    assert.deepEqual(state.state.entries, entries);
  }
});

test('Codex does not recover ordinary request overflow through the local compaction retry path', async () => {
  for (const trigger of ['context-overflow', 'request-too-large']) {
    const state = fixture(largeHistory(), { snapshot: { contextWindow: 1_000 } });
    assert.equal(await createPipeline().run(state.host, trigger), null);
    assert.equal(state.requests.length, 0);
    assert.equal(state.commits.length, 0);
  }
});

test('Codex auto false preserves explicit manual compaction and forwards the active output limit', async () => {
  const state = fixture(largeHistory(), { snapshot: { contextWindow: 1_000, maxOutputTokens: 321 } });
  const pipeline = createPipeline({ auto: false, keepRecentTokens: 0 });
  assert.equal(await pipeline.run(state.host, 'pressure'), null);
  assert.ok(await pipeline.run(state.host, 'manual'));
  assert.equal(state.requests[0].maxTokens, 321);
});

test('Codex recovers retained users from its committed checkpoint after pipeline recreation', async () => {
  const state = fixture(largeHistory());
  await createPipeline({ keepRecentTokens: 100 }).run(state.host, 'manual');
  const retained = joined(state.commits[0].output.beforeSummary ?? []);
  const checkpointSeq = state.state.entries[0].seq;
  state.state.entries.push(entry(checkpointSeq + 1, 'user', 'A new actual request'), entry(checkpointSeq + 2, 'assistant', 'new work '.repeat(1_000)));
  state.state.archive.push(...state.state.entries.slice(1));
  await createPipeline({ keepRecentTokens: 1_000 }).run(state.host, 'manual');
  assert.equal(state.commits.length, 2);
  const restored = joined(state.commits[1].output.beforeSummary ?? []);
  assert.match(restored, /Original request/);
  assert.match(restored, /A new actual request/);
  assert.ok(retained.length > 0);
  assert.equal(state.host.records('codex/checkpoint').length, 2);
});

test('Codex preserves retained users when the host commits an explicit summarizeRange result', async () => {
  const state = fixture(largeHistory());
  await state.host.compact(state.state.entries, () => createPipeline({ keepRecentTokens: 100 }).summarizeRange(state.host, state.state.entries));
  const checkpointSeq = state.state.entries[0].seq;
  state.state.entries.push(entry(checkpointSeq + 1, 'user', 'Continue after the explicit range'), entry(checkpointSeq + 2, 'assistant', 'new work '.repeat(1_000)));
  state.state.archive.push(...state.state.entries.slice(1));
  await createPipeline({ keepRecentTokens: 1_000 }).run(state.host, 'manual');
  assert.equal(state.commits.length, 2);
  const restored = joined(state.commits[1].output.beforeSummary ?? []);
  assert.match(restored, /Original request/);
  assert.match(restored, /Continue after the explicit range/);
});

test('Codex ignores prepared retention records that do not match a committed live checkpoint', async () => {
  const state = fixture([entry(1, 'user', 'Uncommitted earlier request'), entry(2, 'assistant', 'old work '.repeat(1_000))]);
  await createPipeline().summarizeRange(state.host, state.state.entries);
  assert.equal(state.commits.length, 0);
  assert.equal(state.host.records('codex/checkpoint').length, 1);
  state.state.entries = [
    entry(100, 'user', 'A different committed checkpoint', { source: { kind: 'compact-checkpoint', compactionId: 'different-compaction' } }),
    entry(101, 'user', 'Actual live user request'),
    entry(102, 'assistant', 'new work '.repeat(1_000)),
  ];
  await createPipeline().run(state.host, 'manual');
  const retained = joined(state.commits[0].output.beforeSummary ?? []);
  assert.doesNotMatch(retained, /Uncommitted earlier request/);
  assert.match(retained, /Actual live user request/);
});

test('Codex preserves tool exchanges across protected messages and selects only completed independent spans', async () => {
  for (const completed of [false, true]) {
    const round = toolRound(1, 'protected-call');
    const update = entry(3, 'developer', 'Permanent update inside the exchange');
    const protectedEntries = [round[0], update, ...(completed ? [round[1]] : [])];
    const entries = [...protectedEntries, entry(4, 'user', 'Later user request '.repeat(100)), entry(5, 'assistant', 'Later work '.repeat(500))];
    const state = fixture(entries);
    const result = await createPipeline({ keepRecentTokens: 0 }).run(state.host, 'manual');
    if (completed) {
      assert.ok(result);
      assert.deepEqual(state.commits[0].selected.map(value => value.seq), [4, 5]);
      assert.deepEqual(state.state.entries.slice(0, protectedEntries.length), protectedEntries);
    } else {
      assert.equal(result, null);
      assert.equal(state.requests.length, 0);
      assert.deepEqual(state.state.entries, entries);
    }
  }
});

test('Codex restores only the fresh snapshot from each context producer after pipeline recreation', async () => {
  const source = { kind: 'workspace-context', form: 'snapshot' };
  const state = fixture([
    entry(1, 'user', 'Actual request'),
    entry(2, 'user', 'Stale workspace snapshot', { source }),
    entry(3, 'user', 'Fresh workspace snapshot', { source }),
    entry(4, 'assistant', 'work '.repeat(1_000)),
  ]);
  await createPipeline().run(state.host, 'manual');
  const firstContext = joined(state.commits[0].output.beforeSummary ?? []);
  assert.match(firstContext, /Fresh workspace snapshot/);
  assert.doesNotMatch(firstContext, /Stale workspace snapshot/);
  const checkpointSeq = state.state.entries[0].seq;
  state.state.entries.push(
    entry(checkpointSeq + 1, 'user', 'Newest workspace snapshot', { source }),
    entry(checkpointSeq + 2, 'user', 'Continue the request'),
    entry(checkpointSeq + 3, 'assistant', 'new work '.repeat(1_000)),
  );
  state.state.archive.push(...state.state.entries.slice(1));
  await createPipeline().run(state.host, 'manual');
  const nextContext = joined(state.commits[1].output.beforeSummary ?? []);
  assert.match(nextContext, /Newest workspace snapshot/);
  assert.doesNotMatch(nextContext, /Stale workspace snapshot|Fresh workspace snapshot/);
});

test('Codex omits an obsolete recovered snapshot when a newer one remains outside the selected span', async () => {
  const source = { kind: 'workspace-context', form: 'snapshot' };
  const current = entry(5, 'user', 'Current workspace snapshot', { source });
  const state = fixture([
    entry(1, 'user', 'Older real request'),
    entry(2, 'user', 'Obsolete workspace snapshot', { source }),
    entry(3, 'assistant', 'earlier work '.repeat(1_000)),
    entry(4, 'developer', 'Permanent instructions'),
    current,
    entry(6, 'user', 'Later real request'),
    entry(7, 'assistant', 'later work '.repeat(1_000)),
  ]);
  await createPipeline().run(state.host, 'manual');
  assert.deepEqual(state.commits[0].selected.map(value => value.seq), [1, 2, 3]);
  assert.doesNotMatch(joined(state.commits[0].output.beforeSummary ?? []), /Obsolete workspace snapshot|Current workspace snapshot/);
  assert.deepEqual(state.state.entries.find(value => value.seq === 5), current);
});

test('Codex distinguishes prepared state for identical checkpoints with different instruction sources', async () => {
  const sourceA = { kind: 'skill', form: 'instructions', path: '/skills/a.md' };
  const sourceB = { kind: 'skill', form: 'instructions', path: '/skills/b.md' };
  const state = fixture([
    entry(1, 'user', 'Identical instructions', { source: sourceA }),
    entry(2, 'user', 'Same user request'),
    entry(3, 'assistant', 'work '.repeat(2_000)),
    entry(4, 'developer', 'Permanent separator'),
    entry(5, 'user', 'Identical instructions', { source: sourceB }),
    entry(6, 'user', 'Same user request'),
    entry(7, 'assistant', 'work '.repeat(2_000)),
  ], { respond: (_request, count) => ({ text: count <= 2 ? 'Same handoff '.repeat(100) : 'Short handoff' }) });
  const pipeline = createPipeline();
  const firstRange = state.state.entries.slice(0, 3);
  await state.host.compact(firstRange, () => pipeline.summarizeRange(state.host, firstRange));
  const firstCheckpoint = state.state.entries[0];
  const secondRange = state.state.entries.filter(value => value.seq >= 5 && value.seq <= 7);
  await state.host.compact(secondRange, () => pipeline.summarizeRange(state.host, secondRange));
  assert.deepEqual(state.commits[0].output, state.commits[1].output);
  const latestSeq = Math.max(...state.state.archive.map(value => value.seq));
  const updatedB = entry(latestSeq + 1, 'user', 'Updated B instructions', { source: sourceB });
  state.state.entries.push(updatedB);
  state.state.archive.push(updatedB);
  await state.host.compact([firstCheckpoint], () => createPipeline().summarizeRange(state.host, [firstCheckpoint]));
  const retained = joined(state.commits[2].output.beforeSummary ?? []);
  assert.match(retained, /Identical instructions/);
  assert.doesNotMatch(retained, /Updated B instructions/);
});
