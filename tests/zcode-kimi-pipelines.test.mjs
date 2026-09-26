import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { createPipeline as zcode, CLEARED_TOOL_RESULT } from '../packages/zcode/dist/pipeline.js';
import { createPipeline as kimi, estimateKimiText, preserveKimiUsers } from '../packages/kimi-code/dist/pipeline.js';

function entry(seq, role, value = 'history '.repeat(500), extra = {}) {
  const content = extra.content ?? [{ type: 'text', text: value }];
  const message = role === 'user'
    ? createUserMessage({ content, source: { kind: 'user' } })
    : role === 'tool' ? createToolResultMessage({ content, callId: ToolCallId(extra.callId ?? `call-${seq}`), isError: extra.isError ?? false })
      : createMessage({ role, content, source: { kind: 'model', provider: 'test', model: 'model' } });
  return { seq, time: 0, tokens: Math.ceil(value.length / 4), message, ...extra, content: undefined };
}

function conversation(count = 8) {
  return Array.from({ length: count }, (_, seq) => entry(seq, seq % 2 === 0 ? 'user' : 'assistant'));
}

function fixture(entries = conversation(), options = {}) {
  const controller = new AbortController();
  const logs = new Map();
  const requests = [];
  const replacements = [];
  const commits = [];
  const reads = [];
  const snapshot = {
    entries: [...entries], archive: [...entries], contextWindow: 40_000, maxOutputTokens: 32_000,
    provider: 'test', model: 'model', tools: [], measuredTokens: 39_000, now: 0,
    cwd: '/workspace', sessionId: 'native-test', requestSeries: 'turn-1', turnKey: 'turn-1', ...options.snapshot,
  };
  let sequence = 10_000;
  const host = {
    signal: controller.signal,
    async snapshot() { return { ...snapshot, entries: [...snapshot.entries], archive: [...snapshot.archive] }; },
    async summarize(request) {
      requests.push(request);
      const result = await options.summarize?.(request, requests.length, controller);
      return result ?? { text: 'Verified continuation summary.', content: [{ type: 'text', text: 'Verified continuation summary.' }], provider: 'test', model: 'model', maxTokens: request.maxTokens, finish: 'stop' };
    },
    replace(changes) {
      replacements.push(...changes);
      snapshot.entries = snapshot.entries.map(item => {
        const change = changes.find(candidate => candidate.seq === item.seq);
        return change ? { ...item, message: { ...item.message, content: change.content } } : item;
      });
    },
    async compact(selected, summarize) {
      const checkpoint = await summarize();
      controller.signal.throwIfAborted();
      commits.push({ selected: [...selected], checkpoint });
      const first = snapshot.entries.findIndex(item => item.seq === selected[0].seq);
      const last = snapshot.entries.findIndex(item => item.seq === selected.at(-1).seq);
      const replacement = entry(sequence++, 'user', checkpoint.summary, {
        content: [...checkpoint.beforeSummary ?? [], { type: 'text', text: checkpoint.summary }, ...checkpoint.restored ?? []],
      });
      replacement.message = { ...replacement.message, source: { kind: 'compact-checkpoint', compactionId: `checkpoint-${sequence}` } };
      snapshot.entries.splice(first, last - first + 1, replacement);
      snapshot.archive.push(replacement);
      snapshot.measuredTokens = 1_000;
      return { checkpoint, shadowedSeqs: selected.map(item => item.seq) };
    },
    async readFile(path, maxChars) { reads.push({ path, maxChars }); return options.files?.[path] ?? null; },
    record(kind, data) { logs.set(kind, [...logs.get(kind) ?? [], data]); },
    records(kind) { return logs.get(kind) ?? []; },
  };
  return { host, snapshot, controller, requests, replacements, commits, reads, logs };
}

const output = checkpoint => [...checkpoint.beforeSummary ?? [], { type: 'text', text: checkpoint.summary }, ...checkpoint.restored ?? []].filter(block => block.type === 'text').map(block => block.text).join('\n');

test('ZCode automatic flow retains its last assistant round while manual flow summarizes all rounds', async () => {
  const automatic = fixture();
  await zcode().run(automatic.host, 'pressure');
  assert.equal(automatic.commits[0].selected.at(-1).seq, 6);
  assert.equal(automatic.snapshot.entries.at(-1).seq, 7);
  const manual = fixture();
  await zcode().run(manual.host, 'manual');
  assert.equal(manual.commits[0].selected.length, 8);
});

test('ZCode requires two summarizable assistant-started rounds', async () => {
  const small = fixture([entry(0, 'user'), entry(1, 'assistant')]);
  assert.equal(await zcode().run(small.host, 'pressure'), null);
  assert.equal(small.requests.length, 0);
});

test('ZCode provider usage anchors include cached input and new messages', async () => {
  const entries = conversation().map(item => ({ ...item, message: { ...item.message, content: [{ type: 'text', text: 'tiny' }] } }));
  entries[5].usage = { inputTokens: 1_000, cacheReadTokens: 5_000, outputTokens: 100 };
  const item = fixture(entries);
  await zcode({ prune: false }).run(item.host, 'pressure');
  assert.equal(item.commits.length, 1);
});

test('ZCode idle microcompaction keeps five complete groups and is idempotent', async () => {
  const entries = [];
  for (let group = 0; group < 7; group++) {
    const ids = [`a-${group}`, `b-${group}`];
    entries.push(entry(entries.length, 'assistant', '', { content: ids.map(id => ({ type: 'tool-call', id: ToolCallId(id), name: 'Read', arguments: '{}' })) }));
    for (const id of ids) entries.push(entry(entries.length, 'tool', 'result '.repeat(500), { callId: id }));
  }
  const item = fixture(entries, { snapshot: { contextWindow: 1_000_000, now: 60 * 60_000 + 1 } });
  await zcode().run(item.host, 'pressure');
  assert.equal(item.replacements.length, 4);
  assert.equal(item.replacements[0].content[0].text, CLEARED_TOOL_RESULT);
  assert.equal(item.requests.length, 0);
  assert.equal(item.host.records('zcode/microcompact')[0].trigger, 'idle');
  await zcode().run(item.host, 'pressure');
  assert.equal(item.replacements.length, 4);
});

test('ZCode summary overflow preserves additional recent rounds before retrying', async () => {
  const item = fixture(conversation(10), { summarize(_request, attempt) {
    if (attempt === 1) throw Object.assign(new Error('context window exceeded'), { code: 'CONTEXT_WINDOW_EXCEEDED' });
  } });
  await zcode({ prune: false }).run(item.host, 'pressure');
  assert.equal(item.requests.length, 2);
  assert.ok(item.requests[1].messages.length < item.requests[0].messages.length);
  assert.equal(item.commits[0].selected.at(-1).seq, 6);
  assert.deepEqual(item.snapshot.entries.slice(-3).map(item => item.seq), [7, 8, 9]);
});

test('ZCode manual overflow drops oldest complete rounds only in the auxiliary request', async () => {
  const item = fixture(conversation(8), { summarize(_request, attempt) {
    if (attempt === 1) throw Object.assign(new Error('prompt too long'), { code: 'CONTEXT_WINDOW_EXCEEDED' });
  } });
  await zcode().run(item.host, 'manual');
  assert.equal(item.requests.length, 2);
  assert.ok(item.requests[1].messages.filter(message => message.id).length < item.requests[0].messages.length);
  assert.match(item.requests[1].messages[0].content[0].text, /truncated for this compaction retry/);
  assert.equal(item.commits[0].selected.length, 8);
});

test('ZCode media failure retries a text projection without changing retained media', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } };
  const entries = conversation();
  entries[0] = entry(0, 'user', '', { content: [{ type: 'text', text: 'image request' }, image] });
  const item = fixture(entries, { summarize(_request, attempt) {
    if (attempt === 1) throw Object.assign(new Error('image too large'), { code: 'MEDIA_TOO_LARGE' });
  } });
  await zcode().run(item.host, 'manual');
  assert.ok(item.requests[0].messages.some(message => message.content.some(block => block.type === 'image')));
  assert.equal(item.requests[1].messages.some(message => message.content.some(block => block.type === 'image')), false);
  assert.equal(item.snapshot.archive[0].message.content[1].type, 'image');
});

test('ZCode restores observed plan and prior Read results and strips analysis tags', async () => {
  const entries = conversation();
  entries.splice(2, 0,
    entry(100, 'assistant', '', { content: [{ type: 'tool-call', id: ToolCallId('read'), name: 'Read', arguments: '{"file_path":"/workspace/a.ts"}' }] }),
    entry(101, 'tool', 'const value = 42;', { callId: 'read' }));
  const item = fixture(entries, { snapshot: { recovery: { approvedPlanPath: '/workspace/approved.md', transcriptPath: '/logs/session.jsonl' } },
    files: { '/workspace/approved.md': 'Finish the parser.' },
    summarize() { return { text: '<analysis>private scratch</analysis><summary>Keep the parser decision.</summary>', content: [], provider: 'test', model: 'model', maxTokens: 20_000 }; },
  });
  await zcode().run(item.host, 'manual');
  const restored = output(item.commits[0].checkpoint);
  assert.match(restored, /Finish the parser/);
  assert.match(restored, /const value = 42/);
  assert.match(restored, /\/logs\/session.jsonl/);
  assert.doesNotMatch(restored, /private scratch|cleared REPL/);
});

test('ZCode durable failure breaker survives pipeline recreation and manual recovery clears it', async () => {
  let failing = true;
  const item = fixture(undefined, { summarize() { if (failing) throw new Error('provider unavailable'); } });
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(zcode({ maxSummaryAttempts: 1 }).run(item.host, 'pressure'), /provider unavailable/);
  assert.equal(await zcode().run(item.host, 'pressure'), null);
  assert.equal(item.requests.length, 3);
  failing = false;
  await zcode().run(item.host, 'manual');
  assert.equal(item.host.records('zcode/state').at(-1).failures, 0);
});

test('Kimi called service compacts full history and restores genuine user inputs before the summary', async () => {
  const item = fixture();
  await kimi().run(item.host, 'pressure');
  assert.equal(item.commits[0].selected.length, 8);
  assert.equal(item.commits[0].checkpoint.beforeSummary.length, 4);
  assert.match(output(item.commits[0].checkpoint), /Continue the work/);
  assert.equal(await kimi().run(item.host, 'pressure'), null);
});

test('Kimi restoration keeps oldest 2k and newest 18k tokens with a middle omission notice', async () => {
  const entries = [entry(0, 'user', 'A'.repeat(12_000)), entry(1, 'assistant'), entry(2, 'user', 'B'.repeat(100_000)), entry(3, 'assistant'), entry(4, 'user', 'C'.repeat(8_000)), entry(5, 'assistant')];
  const item = fixture(entries, { snapshot: { contextWindow: 1_000_000 } });
  await kimi().run(item.host, 'manual');
  const restored = item.commits[0].checkpoint.beforeSummary.filter(block => block.type === 'text').map(block => block.text).join('');
  assert.ok(restored.startsWith('A'.repeat(8_000)));
  assert.ok(restored.endsWith('C'.repeat(8_000)));
  assert.match(restored, /Middle user messages were omitted/);
  assert.ok(estimateKimiText(restored) < 20_200);
});

test('Kimi summary overflows shrink request history, retain full replacement region and record observed capacity', async () => {
  const item = fixture(conversation(20), { snapshot: { contextWindow: 1_000_000 }, summarize(_request, attempt) {
    if (attempt <= 2) throw Object.assign(new Error('context overflow'), { code: 'CONTEXT_WINDOW_EXCEEDED' });
  } });
  await kimi().run(item.host, 'manual');
  assert.equal(item.requests.length, 3);
  assert.ok(item.requests[1].messages.length < item.requests[0].messages.length);
  assert.ok(item.requests[2].messages.length < item.requests[1].messages.length);
  assert.equal(item.commits[0].selected.length, 20);
  assert.deepEqual(item.host.records('kimi-code/summary-retry').map(record => record.shrinkRatio), [0.7, 0.5]);
  assert.ok(item.host.records('kimi-code/state').some(record => record.observedWindow < 1_000_000));
});

test('Kimi retries truncated or empty summaries and restores authoritative TODO and log pointers', async () => {
  const item = fixture(undefined, { snapshot: { recovery: { todos: '- [ ] Complete parser', wirePath: '/logs/wire.jsonl', windowLines: 'Lines 1-90' } },
    summarize(_request, attempt) { if (attempt === 1) return { text: 'partial', content: [], finish: 'max-tokens', provider: 'test', model: 'model', maxTokens: 32_000 }; },
  });
  await kimi().run(item.host, 'manual');
  assert.equal(item.requests.length, 2);
  assert.match(output(item.commits[0].checkpoint), /Complete parser/);
  assert.match(output(item.commits[0].checkpoint), /\/logs\/wire.jsonl/);
  assert.match(output(item.commits[0].checkpoint), /Lines 1-90/);
});

test('Kimi rejects a low-pressure request-too-large error without consuming overflow retries', async () => {
  const item = fixture(undefined, { snapshot: { contextWindow: 200_000, measuredTokens: 50_000 } });
  assert.equal(await kimi().run(item.host, 'request-too-large'), null);
  assert.equal(item.host.records('kimi-code/state').length, 0);
});

test('both native flows stop after cancellation without committing or recording failures', async () => {
  for (const create of [zcode, kimi]) {
    const item = fixture(undefined, { summarize(_request, _attempt, controller) { controller.abort(new Error('user cancelled')); } });
    await assert.rejects(create().run(item.host, 'manual'), /user cancelled/);
    assert.equal(item.commits.length, 0);
    assert.equal(item.host.records('zcode/state').length, 0);
  }
});

test('ZCode microcompaction preserves failed and image tool results', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } };
  const entries = [entry(0, 'assistant', '', { content: ['failed', 'media', 'plain'].map(id => ({ type: 'tool-call', id: ToolCallId(id), name: 'Read', arguments: '{}' })) }),
    entry(1, 'tool', 'error '.repeat(500), { callId: 'failed', isError: true }), entry(2, 'tool', '', { callId: 'media', content: [image] }), entry(3, 'tool', 'output '.repeat(500), { callId: 'plain' })];
  for (let i = 0; i < 6; i++) entries.push(entry(10 + i * 2, 'assistant', '', { content: [{ type: 'tool-call', id: ToolCallId(`call-${i}`), name: 'Read', arguments: '{}' }] }), entry(11 + i * 2, 'tool', 'output '.repeat(500), { callId: `call-${i}` }));
  const item = fixture(entries, { snapshot: { contextWindow: 1_000_000, now: 60 * 60_000 + 1 } });
  await zcode().run(item.host, 'pressure');
  assert.deepEqual(item.replacements.map(change => change.seq), [3, 11]);
  assert.equal(item.snapshot.entries[1].message.isError, true);
  assert.equal(item.snapshot.entries[2].message.content[0].type, 'image');
});

test('ZCode only subtracts pruned tokens that were part of the provider usage anchor', async () => {
  const entries = [entry(0, 'assistant', 'anchor', { usage: { inputTokens: 1_000, outputTokens: 1 } })];
  for (let i = 0; i < 7; i++) entries.push(entry(1 + i * 2, 'assistant', '', { content: [{ type: 'tool-call', id: ToolCallId(`tool-${i}`), name: 'Read', arguments: '{}' }] }), entry(2 + i * 2, 'tool', 'output '.repeat(500), { callId: `tool-${i}` }));
  const item = fixture(entries, { snapshot: { contextWindow: 1_000_000, now: 60 * 60_000 + 1 } });
  await zcode().run(item.host, 'pressure');
  assert.equal(item.host.records('zcode/microcompact')[0].savedTokens, 0);
  assert.ok(item.host.records('zcode/microcompact')[0].totalSavedTokens > 256);
});

function addToolBatch(item, count = 1) {
  let sequence = Math.max(...item.snapshot.archive.map(entry => entry.seq)) + 1;
  for (let i = 0; i < count; i++) {
    const callId = `batch-${sequence}`;
    const entries = [entry(sequence++, 'assistant', '', { content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'Bash', arguments: '{}' }] }), entry(sequence++, 'tool', 'task output', { callId }), entry(sequence++, 'assistant', 'next step')];
    item.snapshot.entries.push(...entries);
    item.snapshot.archive.push(...entries);
  }
  item.snapshot.measuredTokens = 39_000;
  item.snapshot.requestSeries = `step-${sequence}`;
}

test('ZCode reactive recovery is limited per model step and resets after a completed step', async () => {
  const item = fixture();
  await zcode().run(item.host, 'context-overflow');
  assert.equal(await zcode().run(item.host, 'context-overflow'), null);
  assert.equal(item.requests.length, 1);
  addToolBatch(item);
  await zcode().run(item.host, 'context-overflow');
  assert.equal(item.requests.length, 2);
});

test('ZCode rapid refill breaker blocks a fourth compaction and resets on a new turn', async () => {
  const item = fixture();
  await zcode({ thresholdRatio: 0.00001 }).run(item.host, 'pressure');
  for (let i = 0; i < 2; i++) {
    addToolBatch(item);
    await zcode({ thresholdRatio: 0.00001 }).run(item.host, 'pressure');
  }
  addToolBatch(item);
  await assert.rejects(zcode({ thresholdRatio: 0.00001 }).run(item.host, 'pressure'), /refilled/);
  assert.equal(item.requests.length, 3);
  item.snapshot.turnKey = 'new-turn';
  await zcode({ thresholdRatio: 0.00001 }).run(item.host, 'pressure');
  assert.equal(item.requests.length, 4);
});

test('ZCode three completed tool batches reset rapid refill tracking', async () => {
  const item = fixture();
  await zcode({ thresholdRatio: 0.00001 }).run(item.host, 'pressure');
  addToolBatch(item, 3);
  await zcode({ thresholdRatio: 0.00001 }).run(item.host, 'pressure');
  assert.equal(item.host.records('zcode/state').at(-1).rapidRefills, 0);
});

test('ZCode does not retry an explicitly nonretryable summary error', async () => {
  const item = fixture(undefined, { summarize() { throw Object.assign(new Error('invalid credentials'), { retryable: false }); } });
  await assert.rejects(zcode().run(item.host, 'pressure'), /invalid credentials/);
  assert.equal(item.requests.length, 1);
});

test('Kimi restores each logical user once using its latest logged representation', async () => {
  const original = entry(0, 'user', 'original media placeholder');
  const revised = { ...entry(10, 'user', 'restored media reference'), message: { ...original.message, content: [{ type: 'text', text: 'restored media reference' }] } };
  assert.deepEqual(preserveKimiUsers([original, revised]), [{ type: 'text', text: 'restored media reference' }]);
});

test('Kimi wrapped overflow errors shrink auxiliary history', async () => {
  const item = fixture(undefined, { summarize(_request, attempt) { if (attempt === 1) throw new Error('provider request failed', { cause: Object.assign(new Error('context overflow'), { code: 'CONTEXT_WINDOW_EXCEEDED' }) }); } });
  await kimi().run(item.host, 'manual');
  assert.equal(item.requests.length, 2);
  assert.ok(item.requests[1].messages.length < item.requests[0].messages.length);
});

test('both native flows reject tool calls, media and failed summary responses without committing', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } };
  for (const create of [zcode, kimi]) for (const invalid of [
    { content: [{ type: 'tool-call', id: ToolCallId('summary-call'), name: 'Bash', arguments: '{}' }] },
    { content: [image] }, { finish: 'error' }, { finish: 'aborted' },
  ]) {
    const item = fixture(undefined, { summarize() { return { text: 'invalid output', content: [{ type: 'text', text: 'invalid output' }], provider: 'test', model: 'model', maxTokens: 10, ...invalid }; } });
    await assert.rejects(create().run(item.host, 'manual'), /unsupported response/);
    assert.equal(item.commits.length, 0);
    assert.equal(item.requests.length, 1);
  }
});

test('plugins retain their independently pinned source revisions and expose their actual summary prompt', async () => {
  for (const [name, revision] of [['zcode', '29628c9acdb81b703bbd4080c207a0e7ce5e276e'], ['kimi-code', 'be7d5f5fea7800778e4660cd5f36780ba783bddd']]) {
    const { strategy } = await import(`../packages/${name}/dist/index.js`);
    const { SUMMARY_INSTRUCTIONS } = await import(`../packages/${name}/dist/pipeline.js`);
    assert.equal(strategy.source.revision, revision);
    assert.equal(strategy.summaryInstructions, SUMMARY_INSTRUCTIONS);
  }
});
