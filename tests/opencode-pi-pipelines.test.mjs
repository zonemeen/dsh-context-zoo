import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { createPipeline as openCode } from '../packages/opencode/dist/pipeline.js';
import { createPipeline as pi } from '../packages/pi/dist/pipeline.js';

function entry(seq, role, text, extra = {}) {
  const content = extra.content ?? [{ type: 'text', text }];
  const message = role === 'system' ? createSystemMessage(text)
    : role === 'assistant' ? createAssistantMessage({ content, source: { provider: 'fixture', model: 'model' } })
      : role === 'tool' ? createToolResultMessage({ callId: ToolCallId(extra.callId ?? `call-${seq - 1}`), content, isError: extra.isError ?? false })
        : createUserMessage({ content, source: { kind: 'user' } });
  return { seq, time: seq, tokens: 1, ...extra, message };
}

function toolCall(seq, name, path, text = '') {
  return entry(seq, 'assistant', '', { content: [
    { type: 'text', text },
    { type: 'tool-call', id: ToolCallId(`call-${seq}`), name, arguments: JSON.stringify({ path }) },
  ] });
}

function checkpoint(seq, text) {
  const value = entry(seq, 'user', text);
  return { ...value, message: { ...value.message, source: { kind: 'compact-checkpoint', compactionId: `checkpoint-${seq}` } } };
}

/** Mutations occur only after a complete callback, as required by the host transaction. */
function fakeHost(initialEntries, options = {}) {
  const state = { entries: [...initialEntries], archive: [...initialEntries], requestSeries: 'request-1' };
  const calls = [];
  const commits = [];
  const replacements = [];
  const records = new Map();
  const responses = [...(options.responses ?? [])];
  let nextSeq = Math.max(0, ...initialEntries.map(value => value.seq)) + 1;
  const controller = new AbortController();
  const host = {
    signal: controller.signal,
    async snapshot() {
      return {
        contextWindow: 20_000, maxOutputTokens: 1_000, measuredTokens: 1,
        provider: 'fixture', model: 'model', now: 100_000, cwd: '/project', tools: [],
        ...options.snapshot, ...state,
      };
    },
    async summarize(request) {
      calls.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      const text = response?.text ?? `Checkpoint ${calls.length}: retain the unfinished request.`;
      return { text, content: [{ type: 'text', text }], provider: 'fixture', model: 'model', maxTokens: request.maxTokens, finish: 'stop', ...response };
    },
    replace(changes) {
      for (const change of changes) {
        const index = state.entries.findIndex(value => value.seq === change.seq);
        assert.ok(index >= 0);
        const old = state.entries[index];
        assert.ok(['user', 'tool'].includes(old.message.role));
        state.entries[index] = { ...old, message: { ...old.message, content: [...change.content] } };
      }
      replacements.push(...changes);
    },
    async compact(selected, summarize) {
      assert.ok(selected.every(value => !['system', 'developer'].includes(value.message.role)));
      const output = await summarize();
      controller.signal.throwIfAborted();
      const first = state.entries.findIndex(value => value.seq === selected[0].seq);
      assert.deepEqual(state.entries.slice(first, first + selected.length).map(value => value.seq), selected.map(value => value.seq));
      const replacement = checkpoint(nextSeq++, output.summary);
      replacement.message = { ...replacement.message, content: [...replacement.message.content, ...(output.restored ?? [])] };
      state.entries.splice(first, selected.length, replacement);
      state.archive.push(replacement);
      commits.push({ selected: [...selected], output });
      return { compactionId: `operation-${commits.length}`, summary: [{ type: 'text', text: output.summary }], shadowedSeqs: selected.map(value => value.seq) };
    },
    async readFile() { return null; },
    record(kind, data) { records.set(kind, [...(records.get(kind) ?? []), structuredClone(data)]); },
    records(kind) { return records.get(kind) ?? []; },
  };
  return { host, state, calls, commits, replacements, controller };
}

function twoTurns(usage = undefined) {
  return [
    entry(0, 'system', 'Persistent system instructions.'),
    entry(1, 'user', 'old request '.repeat(200)),
    entry(2, 'assistant', 'old work '.repeat(200)),
    entry(3, 'user', 'latest request'),
    entry(4, 'assistant', 'latest answer', usage ? { usage } : {}),
  ];
}

test('OpenCode uses provider totals and input limits, and preserves complete recent turns', async () => {
  const low = fakeHost(twoTurns({ totalTokens: 8_999, inputTokens: 1, outputTokens: 1 }), { snapshot: { inputLimit: 10_000 } });
  assert.equal(await openCode({ keepRecentTokens: 100 }).run(low.host, 'pressure'), null);
  const high = fakeHost(twoTurns({ totalTokens: 9_000, inputTokens: 1, outputTokens: 1 }), { snapshot: { inputLimit: 10_000 } });
  assert.ok(await openCode({ keepRecentTokens: 100 }).run(high.host, 'pressure'));
  assert.deepEqual(high.commits[0].selected.map(value => value.seq), [1, 2]);
  assert.equal(high.state.entries[0].message.role, 'system');
  assert.deepEqual(high.state.entries.slice(-2).map(value => value.seq), [3, 4]);
  assert.deepEqual(high.calls[0].messages, []);
  assert.equal(high.calls[0].includeTools, false);
  assert.match(high.calls[0].instruction, /\[User\]: old request/);
  assert.doesNotMatch(high.calls[0].instruction, /latest request/);
  assert.ok(high.commits[0].output.restored.length > 0);

  const estimated = fakeHost(twoTurns(), { snapshot: { contextWindow: 1_500 } });
  assert.ok(await openCode({ keepRecentTokens: 100 }).run(estimated.host, 'pressure'));
});

test('OpenCode can keep a balanced suffix of an oversized turn with one history summary', async () => {
  const history = [
    entry(1, 'user', 'old task '.repeat(200)), entry(2, 'assistant', 'old answer '.repeat(200)),
    entry(3, 'user', 'current request '.repeat(200)),
    toolCall(4, 'read', '/project/current.ts', 'earlier step '.repeat(200)),
    entry(5, 'tool', 'large output '.repeat(200)), entry(6, 'assistant', 'recent suffix'),
  ];
  const fixture = fakeHost(history);
  assert.ok(await openCode({ keepRecentTokens: 100 }).run(fixture.host, 'manual'));
  assert.deepEqual(fixture.commits[0].selected.map(value => value.seq), [1, 2, 3, 4, 5]);
  assert.equal(fixture.state.entries.at(-1).seq, 6);
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].instruction, /current request/);
  assert.doesNotMatch(fixture.calls[0].instruction, /recent suffix/);
});

test('OpenCode pruning honors the strict savings gate, protected tools, recent turns, and previous checkpoint', async () => {
  function history(chars) {
    return [
      entry(0, 'tool', 'very old output '.repeat(10_000), { toolName: 'read' }),
      checkpoint(1, 'Previous summary'),
      entry(2, 'user', 'old request'),
      entry(3, 'tool', 'skill output '.repeat(10_000), { toolName: 'skill' }),
      entry(4, 'tool', 'x'.repeat(chars), { toolName: 'read' }),
      entry(5, 'tool', 'y'.repeat(160_000), { toolName: 'read' }),
      entry(6, 'user', 'recent request'),
      entry(7, 'assistant', 'recent response'),
      entry(8, 'user', 'latest request'),
      entry(9, 'assistant', 'latest response', { usage: { inputTokens: 1, outputTokens: 0 } }),
    ];
  }
  const exact = fakeHost(history(80_000));
  assert.equal(await openCode({ prune: true }).run(exact.host, 'pressure'), null);
  assert.equal(exact.replacements.length, 0);
  const above = fakeHost(history(80_004));
  assert.equal(await openCode({ prune: true }).run(above.host, 'pressure'), null);
  assert.deepEqual(above.replacements.map(value => value.seq), [4]);
  assert.equal(above.replacements[0].content[0].text, '[Old tool result content cleared]');
  assert.equal(above.state.entries.find(value => value.seq === 5).message.content[0].text.length, 160_000);
  assert.equal(above.calls.length, 0);
});

test('OpenCode overflow replays the latest user with media descriptions only after a valid checkpoint', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } };
  const history = twoTurns().slice(0, -1);
  history[3] = entry(3, 'user', '', { content: [{ type: 'text', text: 'Inspect this image.' }, image] });
  const success = fakeHost(history);
  assert.ok(await openCode({ keepRecentTokens: 0 }).run(success.host, 'request-too-large'));
  assert.deepEqual(success.commits[0].selected.map(value => value.seq), [1, 2]);
  assert.match(success.state.entries.at(-1).message.content[1].text, /Attached image\/png/);
  assert.match(success.commits[0].output.restored[0].text, /latest request/);

  const failed = fakeHost(history, { responses: [{ finish: 'max-tokens' }] });
  await assert.rejects(openCode({ keepRecentTokens: 0 }).run(failed.host, 'request-too-large'), /truncated/);
  assert.deepEqual(failed.state.entries, history);
  assert.equal(failed.replacements.length, 0);
  assert.equal(failed.host.records('opencode/checkpoint').length, 0);
});

test('OpenCode merges previous checkpoints and clips summary tool output without changing the archive', async () => {
  const history = [entry(1, 'user', 'Inspect the file.'), toolCall(2, 'read', '/project/a.ts'), entry(3, 'tool', 'z'.repeat(3_000))];
  const fixture = fakeHost(history);
  fixture.host.record('opencode/checkpoint', { summary: 'Preserve the earlier user constraint.' });
  const output = await openCode().summarizeRange(fixture.host, history);
  assert.match(fixture.calls[0].instruction, /<prior-summary>\nPreserve the earlier user constraint/);
  assert.match(fixture.calls[0].instruction, /read\(\{"path":"\/project\/a.ts"\}\)/);
  assert.ok(fixture.calls[0].instruction.includes('z'.repeat(2_000) + '\n[truncated]'));
  assert.equal(fixture.state.archive[2].message.content[0].text.length, 3_000);
  assert.ok(output.summary);
});

test('Pi adds trailing estimates to valid usage, ignores failed usage, and triggers strictly above the threshold', async () => {
  const history = [
    entry(1, 'user', 'history '.repeat(200)),
    entry(2, 'assistant', 'answer', { usage: { inputTokens: 500, outputTokens: 0 }, finish: 'stop' }),
    entry(3, 'user', 'a'.repeat(400)),
    entry(4, 'assistant', '', { usage: { inputTokens: 999_999, outputTokens: 0 }, finish: 'error' }),
  ];
  const exact = fakeHost(history, { snapshot: { contextWindow: 700 } });
  assert.equal(await pi({ reserveTokens: 100, keepRecentTokens: 1 }).run(exact.host, 'pressure'), null);
  const above = fakeHost([...history, entry(5, 'user', 'more')], { snapshot: { contextWindow: 700 } });
  assert.ok(await pi({ reserveTokens: 100, keepRecentTokens: 1 }).run(above.host, 'pressure'));
  assert.equal(above.calls[0].maxTokens, 80);
  const stale = fakeHost([checkpoint(10, 'new checkpoint'), history[1], history[2]], { snapshot: { contextWindow: 700 } });
  assert.equal(await pi({ reserveTokens: 100, keepRecentTokens: 1 }).run(stale.host, 'pressure'), null);
});

function splitTurnHistory() {
  return [
    entry(0, 'system', 'system rules'),
    entry(1, 'user', 'Earlier task '.repeat(100)),
    toolCall(2, 'read', '/project/read.ts', 'Earlier answer '.repeat(100)),
    entry(3, 'tool', 'Earlier output '.repeat(100)),
    entry(4, 'user', 'Current unfinished request '.repeat(100)),
    toolCall(5, 'edit', '/project/edit.ts', 'Early progress '.repeat(100)),
    entry(6, 'tool', 'Early output '.repeat(100)),
    entry(7, 'assistant', 'Recent progress '.repeat(20)),
  ];
}

test('Pi split turns use two differently budgeted calls and persist accumulated file lineage', async () => {
  const fixture = fakeHost(splitTurnHistory(), { responses: [{ text: 'History checkpoint' }, { text: 'Turn prefix checkpoint' }] });
  fixture.host.record('pi/checkpoint', { summary: 'Earlier unresolved constraint.\n\n<read-files>\n/project/inherited.ts\n</read-files>' });
  const pipeline = pi({ reserveTokens: 1_000, keepRecentTokens: 20 });
  assert.ok(await pipeline.run(fixture.host, 'manual'));
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0].maxTokens, 800);
  assert.equal(fixture.calls[1].maxTokens, 500);
  assert.match(fixture.calls[0].instruction, /<previous-summary>\nEarlier unresolved constraint/);
  assert.doesNotMatch(fixture.calls[0].instruction, /Current unfinished request/);
  assert.match(fixture.calls[1].instruction, /Current unfinished request/);
  assert.match(fixture.calls[1].instruction, /## Context for Suffix/);
  assert.deepEqual(fixture.commits[0].selected.map(value => value.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(fixture.state.entries.at(-1).seq, 7);
  const summary = fixture.commits[0].output.summary;
  assert.match(summary, /History checkpoint[\s\S]*Turn Context \(split turn\)[\s\S]*Turn prefix checkpoint/);
  assert.match(summary, /<read-files>\n\/project\/inherited.ts\n\/project\/read.ts\n<\/read-files>/);
  assert.match(summary, /<modified-files>\n\/project\/edit.ts\n<\/modified-files>/);

  const branch = [entry(20, 'user', summary), toolCall(21, 'write', '/project/read.ts'), entry(22, 'tool', 'written')];
  const before = [...fixture.state.entries];
  const branchSummary = await pi().summarizeBranch(fixture.host, branch);
  assert.match(branchSummary, /different conversation branch/);
  assert.match(branchSummary, /<modified-files>\n\/project\/edit.ts\n\/project\/read.ts\n<\/modified-files>/);
  assert.match(branchSummary, /<read-files>\n\/project\/inherited.ts\n<\/read-files>/);
  assert.deepEqual(fixture.state.entries, before);
  assert.equal(fixture.host.records('pi/branch').length, 1);
});

test('Pi does not commit the first split summary when the prefix summary is truncated', async () => {
  const history = splitTurnHistory();
  const fixture = fakeHost(history, { responses: [{ text: 'Valid history summary' }, { text: 'Incomplete prefix', finish: 'max-tokens' }] });
  await assert.rejects(pi({ keepRecentTokens: 20 }).run(fixture.host, 'manual'), /truncated/);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.commits.length, 0);
  assert.deepEqual(fixture.state.entries, history);
  assert.equal(fixture.host.records('pi/checkpoint').length, 0);
});

test('Pi keeps an oversized trailing tool exchange when no valid retained cut follows its result', async () => {
  const history = [
    entry(1, 'user', 'older request '.repeat(100)), entry(2, 'assistant', 'older answer '.repeat(100)),
    entry(3, 'user', 'current request'), toolCall(4, 'read', '/project/large.ts'),
    entry(5, 'tool', 'large result '.repeat(1_000)),
  ];
  const fixture = fakeHost(history);
  assert.equal(await pi({ keepRecentTokens: 20 }).run(fixture.host, 'manual'), null);
  assert.deepEqual(fixture.state.entries, history);
  assert.equal(fixture.calls.length, 0);

  const branch = [checkpoint(10, 'An earlier branch decision must survive.\n\n<read-files>\n/project/old.ts\n</read-files>'), entry(11, 'user', 'new branch request')];
  await pi().summarizeBranch(fixture.host, branch);
  assert.match(fixture.calls[0].instruction, /An earlier branch decision must survive/);
});

test('Pi retries transient summary failures but never retries quota failures or tool-calling summaries', async () => {
  const history = splitTurnHistory().slice(1, 4);
  const retry = fakeHost(history, { responses: [new Error('socket hang up'), { text: 'Recovered summary' }] });
  assert.equal((await pi({ summaryRetryDelayMs: 0 }).summarizeRange(retry.host, history)).summary.includes('Recovered summary'), true);
  assert.equal(retry.calls.length, 2);
  const quota = fakeHost(history, { responses: [new Error('429 insufficient_quota')] });
  await assert.rejects(pi({ summaryRetryDelayMs: 0 }).summarizeRange(quota.host, history), /insufficient_quota/);
  assert.equal(quota.calls.length, 1);
  const tool = fakeHost(history, { responses: [{ content: [{ type: 'tool-call', id: ToolCallId('unexpected'), name: 'read', arguments: '{}' }] }] });
  await assert.rejects(pi().summarizeRange(tool.host, history), /attempted to call a tool/);
  assert.equal(tool.calls.length, 1);
});

test('Pi owns the one-attempt overflow budget even after the pipeline is recreated', async () => {
  const fixture = fakeHost(splitTurnHistory());
  assert.equal(await pi({ keepRecentTokens: 20, reserveTokens: 0 }).run(fixture.host, 'pressure'), null);
  assert.ok(await pi({ keepRecentTokens: 20 }).run(fixture.host, 'context-overflow'));
  const calls = fixture.calls.length;
  assert.equal(await pi({ keepRecentTokens: 20 }).run(fixture.host, 'context-overflow'), null);
  assert.equal(fixture.calls.length, calls);
});

for (const [name, create] of [['OpenCode', openCode], ['Pi', pi]]) {
  test(`${name} compacts both sides of protected updates while skipping an uncompactable retained span`, async () => {
    const protectedUpdate = entry(5, 'system', 'New permanent instructions.');
    protectedUpdate.message = { ...protectedUpdate.message, role: 'developer' };
    const history = [
      entry(0, 'system', 'Initial instructions.'),
      entry(1, 'user', 'First old request '.repeat(100)), entry(2, 'assistant', 'First old result '.repeat(100)),
      entry(3, 'user', 'Recent request needs followup'), entry(4, 'assistant', 'Recent answer'),
      protectedUpdate,
      entry(6, 'user', 'Second old request '.repeat(100)), entry(7, 'assistant', 'Second old result '.repeat(100)),
      entry(8, 'user', 'Later request needs followup'), entry(9, 'assistant', 'Later answer'),
    ];
    const fixture = fakeHost(history);
    const config = { keepRecentTokens: name === 'OpenCode' ? 100 : 10 };
    assert.ok(await create(config).run(fixture.host, 'manual'));
    assert.deepEqual(fixture.commits[0].selected.map(value => value.seq), [1, 2]);
    assert.ok(await create(config).run(fixture.host, 'manual'));
    assert.deepEqual(fixture.commits[1].selected.map(value => value.seq), [6, 7]);
    assert.deepEqual(fixture.state.entries.filter(value => [0, 3, 4, 5, 8, 9].includes(value.seq)), [history[0], history[3], history[4], history[5], history[8], history[9]]);
    assert.match(fixture.calls.at(-1).instruction, /Checkpoint 1: retain the unfinished request/);
    assert.equal(await create(config).run(fixture.host, 'manual'), null);
  });

  test(`${name} prefers every committed checkpoint over stale saved metadata after resume`, async () => {
    const history = [
      checkpoint(10, 'Committed first-span decision.\n\n<read-files>\n/project/first.ts\n</read-files>'),
      entry(11, 'system', 'Permanent instructions.'),
      checkpoint(12, 'Committed second-span decision.\n\n<modified-files>\n/project/second.ts\n</modified-files>'),
      entry(13, 'user', 'New request '.repeat(100)), entry(14, 'assistant', 'New result '.repeat(100)),
    ];
    const fixture = fakeHost(history);
    fixture.host.record(`${name === 'OpenCode' ? 'opencode' : 'pi'}/checkpoint`, { summary: 'Stale saved decision.' });
    const summary = await create().summarizeRange(fixture.host, history.slice(3));
    assert.match(fixture.calls[0].instruction, /Committed first-span decision/);
    assert.match(fixture.calls[0].instruction, /Committed second-span decision/);
    assert.doesNotMatch(fixture.calls[0].instruction, /Stale saved decision/);
    if (name === 'Pi') {
      assert.match(summary.summary, /<read-files>\n\/project\/first.ts\n<\/read-files>/);
      assert.match(summary.summary, /<modified-files>\n\/project\/second.ts\n<\/modified-files>/);
    }
  });
}

test('Pi includes protected messages in pressure estimates and ignores usage older than any live checkpoint', async () => {
  const entries = twoTurns();
  entries[0] = entry(0, 'system', 'rules '.repeat(1_000));
  const whole = fakeHost(entries, { snapshot: { contextWindow: 2_000 } });
  assert.ok(await pi({ reserveTokens: 100, keepRecentTokens: 1 }).run(whole.host, 'pressure'));
  const stale = fakeHost([
    checkpoint(100, 'New earlier-span summary.'), entry(1, 'system', 'Permanent instructions.'),
    checkpoint(10, 'Older later-span summary.'), entry(20, 'assistant', 'old work', { usage: { inputTokens: 999_999, outputTokens: 0 } }),
    entry(21, 'user', 'recent request'),
  ], { snapshot: { contextWindow: 1_000 } });
  assert.equal(await pi({ reserveTokens: 100, keepRecentTokens: 1 }).run(stale.host, 'pressure'), null);
});
