import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline as claudePipeline } from '../packages/claude-code/dist/pipeline.js';
import { createPipeline as qwenPipeline } from '../packages/qwen-code/dist/pipeline.js';

let nextSeq = 0;
function entry(role, text = 'conversation '.repeat(400), extra = {}) {
  const seq = ++nextSeq;
  return { seq, time: 0, tokens: Math.ceil(text.length / 4), message: { id: `m${seq}`, role, source: role === 'assistant' ? { kind: 'model', provider: 'fake', model: 'fake' } : { kind: 'user' }, content: [{ type: 'text', text }], ...extra }, ...extra.entry };
}
function toolRound(path, output = 'old file contents '.repeat(100), options = {}) {
  const id = `call${nextSeq + 1}`;
  const assistant = entry('assistant', '', { content: [{ type: 'tool-call', id, name: options.name ?? 'read_file', arguments: JSON.stringify({ file_path: path }) }] });
  const result = entry('tool', output, { toolCallId: id, source: { kind: 'tool', callId: id }, isError: options.error, content: options.content ?? [{ type: 'text', text: output }] });
  return [assistant, result];
}
function hostFor(entries, options = {}) {
  let visible = structuredClone(entries);
  const archive = structuredClone(options.archive ?? entries);
  const events = [];
  const requests = [];
  const reads = [];
  const commits = [];
  let reply = options.reply ?? '<summary>Continue the requested change.</summary>';
  const host = {
    signal: new AbortController().signal,
    async snapshot() {
      return { entries: visible, archive, contextWindow: options.window ?? 200_000, maxOutputTokens: options.maxOutputTokens ?? 20_000, provider: 'fake', model: 'fake', tools: [], measuredTokens: 0, now: options.now ?? 7_200_000, cwd: '/workspace', requestSeries: options.series ?? 'turn-1' };
    },
    async summarize(request) {
      requests.push(structuredClone(request));
      const response = typeof reply === 'function' ? await reply(request, requests.length) : { text: reply };
      return { content: [{ type: 'text', text: response.text }], provider: 'fake', model: 'fake', maxTokens: request.maxTokens, ...response };
    },
    replace(replacements) {
      visible = visible.map(value => {
        const found = replacements.find(replacement => replacement.seq === value.seq);
        if (found) assert.ok(['user', 'tool'].includes(value.message.role), 'host replacement only supports user and tool messages');
        return found ? { ...value, message: { ...value.message, content: structuredClone(found.content) } } : value;
      });
    },
    async compact(selected, callback) {
      const before = visible;
      const checkpoint = await callback();
      assert.equal(visible, before, 'summary generation must not rewrite selected history before success');
      const start = visible.findIndex(value => value.seq === selected[0].seq);
      assert.deepEqual(visible.slice(start, start + selected.length).map(value => value.seq), selected.map(value => value.seq));
      const checkpointEntry = entry('user', checkpoint.summary, { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: checkpoint.summary }, ...(checkpoint.restored ?? [])] });
      visible = [...visible.slice(0, start), checkpointEntry, ...visible.slice(start + selected.length)];
      archive.push(checkpointEntry);
      commits.push({ selected, checkpoint });
      return { summary: checkpoint.summary };
    },
    async readFile(path, maxChars) { reads.push({ path, maxChars }); return options.files?.[path]?.slice(0, maxChars) ?? null; },
    record(kind, data) { events.push({ kind, data: structuredClone(data) }); },
    records(kind) { return events.filter(event => event.kind === kind).map(event => event.data); },
  };
  return { host, events, requests, reads, commits, visible: () => visible, setReply(value) { reply = value; } };
}
const xml = '<state_snapshot><current_state>Continue the requested edit.</current_state></state_snapshot>';

test('Claude leaves microcompaction off by default and applies idle clearing only after the interval', async () => {
  const entries = [entry('user'), ...toolRound('/a'), ...toolRound('/b'), ...toolRound('/c'), entry('assistant')];
  const defaultHost = hostFor(entries);
  await claudePipeline({ auto: false }).run(defaultHost.host, 'pressure');
  assert.equal(defaultHost.events.length, 0);
  const fresh = hostFor(entries, { now: 30_000 });
  await claudePipeline({ auto: false, prune: true, keepRecentTools: 1 }).run(fresh.host, 'pressure');
  assert.equal(fresh.events.length, 0);
  const idle = hostFor(entries);
  await claudePipeline({ auto: false, prune: true, keepRecentTools: 1 }).run(idle.host, 'pressure');
  const tools = idle.visible().filter(value => value.message.role === 'tool');
  assert.match(tools[0].message.content[0].text, /idle interval/);
  assert.match(tools[1].message.content[0].text, /idle interval/);
  assert.match(tools[2].message.content[0].text, /old file contents/);
  assert.equal(tools[0].message.toolCallId, entries[2].message.toolCallId);
});

test('Claude retries summary overflow by dropping whole API rounds and keeps the original history until commit', async () => {
  const entries = [entry('user'), ...toolRound('/a'), ...toolRound('/b'), entry('assistant')];
  const state = hostFor(entries, { reply: (_request, number) => {
    if (number === 1) throw new Error('prompt is too long: 220000 tokens > 200000');
    return { text: '<summary>Implement the remaining fix.</summary>' };
  } });
  await claudePipeline({ restoreContext: false }).run(state.host, 'manual');
  assert.equal(state.requests.length, 2);
  assert.ok(state.requests[1].messages.length < state.requests[0].messages.length);
  assert.equal(state.requests[1].messages[0].role, 'user');
  const callIds = new Set(state.requests[1].messages.flatMap(message => message.content.filter(block => block.type === 'tool-call').map(block => block.id)));
  for (const message of state.requests[1].messages) if (message.role === 'tool') assert.ok(callIds.has(message.toolCallId));
  assert.equal(state.commits[0].selected.length, entries.length);
});

test('Claude restores fresh authorized files and the latest durable plan and skill state', async () => {
  const plan = entry('user', 'Plan mode is active: inspect files before edits.', { source: { kind: 'plan-mode', form: 'notice' } });
  const skill = entry('user', 'Run the parser checks after editing.', { source: { kind: 'skill', form: 'instructions', path: '/skills/parser' } });
  const entries = [entry('user'), plan, skill, ...toolRound('/ok'), ...toolRound('/denied', 'permission denied', { error: true }), entry('assistant')];
  const state = hostFor(entries, { files: { '/ok': 'fresh file '.repeat(200), '/denied': 'must not read' } });
  await claudePipeline({ maxFileTokens: 30, maxRestoreTokens: 100 }).run(state.host, 'manual');
  assert.deepEqual(state.reads.map(read => read.path), ['/ok']);
  const restored = state.commits[0].checkpoint.restored.map(block => block.text).join('\n');
  assert.match(restored, /Plan mode is active/);
  assert.match(restored, /parser checks/);
  assert.match(restored, /fresh file/);
  assert.doesNotMatch(restored, /old file contents/);
});

test('Claude prices authoritative cached usage plus new messages instead of a generic measured total', async () => {
  const assistant = entry('assistant', 'work', { entry: { usage: { inputTokens: 20_000, cacheReadTokens: 140_000, cacheWriteTokens: 10_000, outputTokens: 2_000 } } });
  const state = hostFor([entry('user'), assistant, entry('user', 'next')]);
  await claudePipeline({ restoreContext: false }).run(state.host, 'pressure');
  assert.equal(state.commits.length, 1);
});

test('Claude automatic failure breaker survives recreating the pipeline and manual success resets it', async () => {
  const state = hostFor([entry('user'), entry('assistant')], { reply: () => { throw new Error('provider unavailable'); } });
  for (let count = 0; count < 4; count++) await claudePipeline({ thresholdRatio: 0.001, restoreContext: false }).run(state.host, 'pressure');
  assert.equal(state.requests.length, 3);
  assert.equal(state.commits.length, 0);
  state.setReply('<summary>Resume.</summary>');
  await claudePipeline({ restoreContext: false }).run(state.host, 'manual');
  assert.equal(state.host.records('claude.failures').at(-1).count, 0);
});

test('Qwen size clearing reaches its low water target while protecting recent output and errors', async () => {
  const entries = [entry('user'), ...toolRound('/a', 'a'.repeat(100)), ...toolRound('/b', 'b'.repeat(100)), ...toolRound('/c', 'c'.repeat(100)), ...toolRound('/d', 'd'.repeat(100)), ...toolRound('/error', 'error details', { error: true }), entry('assistant')];
  const state = hostFor(entries, { now: 10_000 });
  await qwenPipeline({ auto: false, toolHighWaterChars: 250, toolLowWaterChars: 100, keepRecentTools: 1 }).run(state.host, 'pressure');
  const tools = state.visible().filter(value => value.message.role === 'tool');
  assert.equal(tools.filter(value => /Earlier tool output/.test(value.message.content[0].text)).length, 3);
  assert.equal(tools[3].message.content[0].text, 'd'.repeat(100));
  assert.equal(tools[4].message.content[0].text, 'error details');
  assert.equal(state.host.records('qwen.microcompact')[0].remainingChars, 100);
  assert.deepEqual(state.host.records('qwen.microcompact')[0].evictedFiles, ['/a', '/b', '/c']);
});

test('Qwen idle media clearing protects its own recent-image budget', async () => {
  const images = Array.from({ length: 7 }, (_, index) => ({ type: 'image', attachment: { id: `image${index}`, path: `/image${index}.png` } }));
  const state = hostFor([entry('user', '', { content: images }), entry('assistant')]);
  await qwenPipeline({ auto: false, keepRecentTools: 2 }).run(state.host, 'pressure');
  assert.equal(state.visible()[0].message.content.filter(block => block.type === 'image').length, 2);
  assert.equal(state.visible()[0].message.content.filter(block => block.type === 'text').length, 5);
});

test('Qwen rejects missing and truncated XML without replacing history', async () => {
  for (const reply of [() => ({ text: '<state_snapshot>incomplete' }), request => ({ text: xml, usage: { inputTokens: 1, outputTokens: request.maxTokens } }), () => ({ text: xml, finish: 'max-tokens' })]) {
    const original = [entry('user'), entry('assistant')];
    const state = hostFor(original, { reply });
    await assert.rejects(qwenPipeline({ prune: false }).run(state.host, 'manual'));
    assert.deepEqual(state.visible(), original);
    assert.equal(state.commits.length, 0);
    assert.equal(state.host.records('qwen.failures').at(-1).count, 1);
  }
});

test('Qwen restores files and recent images on regular compaction and suppresses both for HTTP 413 recovery', async () => {
  const images = Array.from({ length: 4 }, (_, index) => ({ type: 'image', attachment: { id: `image${index}` } }));
  const entries = [entry('user'), ...toolRound('/source'), entry('user', '', { content: images }), entry('assistant')];
  for (const trigger of ['manual', 'request-too-large']) {
    const state = hostFor(entries, { reply: xml, files: { '/source': 'fresh source' } });
    await qwenPipeline({ prune: false }).run(state.host, trigger);
    assert.equal(state.commits.length, 1);
    const restored = state.commits[0].checkpoint.restored;
    assert.equal(state.reads.length, trigger === 'manual' ? 1 : 0);
    assert.equal(restored.filter(block => block.type === 'image').length, trigger === 'manual' ? 3 : 0);
    assert.ok(state.requests[0].messages.every(message => message.content.every(block => block.type !== 'image')));
  }
});

test('Qwen protects incomplete trailing tool calls outside the selected summary range', async () => {
  const trailing = toolRound('/pending')[0];
  const state = hostFor([entry('user'), entry('assistant'), trailing], { reply: xml });
  await qwenPipeline({ prune: false, restoreContext: false }).run(state.host, 'manual');
  assert.ok(state.visible().some(value => value.seq === trailing.seq));
  assert.ok(state.commits[0].selected.every(value => value.seq !== trailing.seq));
});

test('Qwen uses usage anchors with conservative new-content pricing and clamps summary output budget', async () => {
  const assistant = entry('assistant', 'response', { entry: { usage: { inputTokens: 150_000, cacheReadTokens: 15_000, outputTokens: 1_000 } } });
  const state = hostFor([entry('user'), assistant, entry('user', 'x'.repeat(8_000))], { reply: xml });
  await qwenPipeline({ prune: false, restoreContext: false }).run(state.host, 'pressure');
  assert.equal(state.commits.length, 1);
  assert.ok(state.requests[0].maxTokens <= 20_000);
});

test('source-owned overflow attempt budgets survive pipeline recreation', async () => {
  for (const [create, prefix] of [[claudePipeline, 'claude'], [qwenPipeline, 'qwen']]) {
    const state = hostFor([entry('user'), entry('assistant')], { reply: () => { throw new Error('provider failed'); } });
    await create({ prune: false, maxOverflowRetries: 1 }).run(state.host, 'context-overflow');
    await create({ prune: false, maxOverflowRetries: 1 }).run(state.host, 'context-overflow');
    assert.equal(state.requests.length, 1);
    assert.equal(state.host.records(`${prefix}.overflow`).at(-1).count, 1);
  }
});

test('both pipelines leave protected system and developer prefixes outside compaction', async () => {
  for (const [create, reply] of [[claudePipeline, '<summary>Resume.</summary>'], [qwenPipeline, xml]]) {
    const system = entry('system', 'System instructions', { source: { kind: 'system-prompt' } });
    const developer = entry('developer', 'Tool catalogue');
    const state = hostFor([system, developer, entry('user'), entry('assistant')], { reply });
    await create({ prune: false, restoreContext: false }).run(state.host, 'manual');
    assert.deepEqual(state.commits[0].selected.map(value => value.message.role), ['user', 'assistant']);
    assert.ok(state.visible().some(value => value.seq === system.seq));
    assert.ok(state.visible().some(value => value.seq === developer.seq));
  }
});

test('restored context including labels remains within the configured token budget', async () => {
  for (const [create, reply] of [[claudePipeline, '<summary>Resume.</summary>'], [qwenPipeline, xml]]) {
    const entries = [entry('user'), ...toolRound('/skill', 'skill body '.repeat(200), { name: 'skill' }), ...toolRound('/source'), entry('assistant')];
    const state = hostFor(entries, { reply, files: { '/source': 'source body '.repeat(500) } });
    await create({ prune: false, maxRestoreTokens: 100, maxSkillTokens: 30, maxFileTokens: 90 }).run(state.host, 'manual');
    const blocks = state.commits[0].checkpoint.restored;
    assert.match(blocks.map(block => block.text).join('\n'), /Invoked skill/);
    assert.ok(blocks.reduce((sum, block) => sum + Math.ceil(block.text.length / 4), 0) <= 100);
  }
});

test('Qwen screenshot pressure counts tool images independently of user image uploads', async () => {
  const images = Array.from({ length: 20 }, (_, index) => ({ type: 'image', attachment: { id: `shot${index}` } }));
  const tools = hostFor([entry('user'), ...toolRound('/screenshots', '', { content: images, name: 'computer' }), entry('assistant')], { now: 100, reply: xml });
  await qwenPipeline({ prune: false, restoreContext: false }).run(tools.host, 'pressure');
  assert.equal(tools.commits.length, 1);
  assert.equal(tools.host.records('qwen.screenshot-trigger')[0].count, 20);
  const user = hostFor([entry('user', '', { content: images }), entry('assistant')], { reply: xml });
  await qwenPipeline({ prune: false, restoreContext: false }).run(user.host, 'pressure');
  assert.equal(user.requests.length, 0);
});

test('Qwen falls back from an overflowing configured summary model before discarding API rounds', async () => {
  const state = hostFor([entry('user'), entry('assistant')], { reply: (_request, number) => {
    if (number === 1) throw new Error('context window exceeded');
    return { text: xml };
  } });
  await qwenPipeline({ prune: false, restoreContext: false, summarizationProvider: 'small', summarizationModel: 'small-model' }).run(state.host, 'manual');
  assert.equal(state.requests[0].provider, 'small');
  assert.equal(state.requests[1].provider, 'fake');
  assert.equal(state.requests[1].messages.length, state.requests[0].messages.length);
  assert.equal(state.host.records('qwen.summary-model-fallback').length, 1);
});

test('Qwen clearing follows surface order when replacement event sequence numbers are nonmonotonic', async () => {
  const first = toolRound('/old', 'x'.repeat(500));
  first[1].seq = 999999;
  const entries = [entry('user'), ...first, ...toolRound('/recent', 'y'.repeat(50)), entry('assistant')];
  const state = hostFor(entries, { now: 100 });
  await qwenPipeline({ toolHighWaterChars: 200, toolLowWaterChars: 100, keepRecentTools: 1 }).run(state.host, 'pressure');
  assert.match(state.visible().find(value => value.seq === 999999).message.content[0].text, /Earlier tool output/);
});

test('summary requests obey the active model output ceiling for both workflows', async () => {
  for (const [create, reply] of [[claudePipeline, '<summary>Resume.</summary>'], [qwenPipeline, xml]]) {
    const state = hostFor([entry('user'), entry('assistant')], { reply, maxOutputTokens: 100 });
    await create({ prune: false, restoreContext: false, maxSummaryTokens: 500 }).run(state.host, 'manual');
    assert.equal(state.requests[0].maxTokens, 100);
  }
});

test('Qwen rejects restoration that would inflate the selected context', async () => {
  const entries = [entry('user'), ...toolRound('/growing-file'), entry('assistant')];
  const state = hostFor(entries, { reply: xml, files: { '/growing-file': 'x'.repeat(40_000) } });
  await assert.rejects(qwenPipeline({ prune: false }).run(state.host, 'manual'), /increase history tokens/);
  assert.deepEqual(state.visible(), entries);
  assert.equal(state.commits.length, 0);
});

test('cancelled summaries preserve history and do not consume the source failure circuit', async () => {
  for (const [create, prefix] of [[claudePipeline, 'claude'], [qwenPipeline, 'qwen']]) {
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    const original = [entry('user'), entry('assistant')];
    const state = hostFor(original, { reply: () => { controller.abort(reason); throw reason; } });
    state.host.signal = controller.signal;
    await assert.rejects(create({ prune: false }).run(state.host, 'manual'), error => error === reason);
    assert.deepEqual(state.visible(), original);
    assert.equal(state.host.records(`${prefix}.failures`).length, 0);
  }
});

test('both workflows advance to history after an in-conversation system or developer update', async () => {
  for (const [create, reply] of [[claudePipeline, '<summary>Resume.</summary>'], [qwenPipeline, xml]]) {
    for (const protectedRole of ['system', 'developer']) {
      const head = entry('system', 'Initial system prompt');
      const first = [entry('user'), entry('assistant')];
      const update = entry(protectedRole, 'Updated instructions or tools');
      const second = [entry('user'), entry('assistant')];
      const state = hostFor([head, ...first, update, ...second], { reply });
      const pipeline = create({ prune: false, restoreContext: false });
      await pipeline.run(state.host, 'manual');
      await pipeline.run(state.host, 'manual');
      assert.deepEqual(state.commits.map(commit => commit.selected.map(value => value.seq)), [first.map(value => value.seq), second.map(value => value.seq)]);
      assert.deepEqual(state.visible().map(value => value.seq).filter(seq => seq === head.seq || seq === update.seq), [head.seq, update.seq]);
      assert.equal(state.visible()[0].seq, head.seq);
      assert.equal(state.visible()[2].seq, update.seq);
      assert.equal(await pipeline.run(state.host, 'manual'), null);
    }
  }
});

test('recent history after a protected update contributes to the retention budget', async () => {
  for (const [create, reply] of [[claudePipeline, '<summary>Resume.</summary>'], [qwenPipeline, xml]]) {
    const older = [entry('user'), entry('assistant')];
    const state = hostFor([...older, entry('system', 'Updated system prompt'), entry('user', 'new context '.repeat(800)), entry('assistant')], { reply });
    await create({ prune: false, restoreContext: false, keepRecentTokens: 1000 }).run(state.host, 'manual');
    assert.deepEqual(state.commits[0].selected.map(value => value.seq), older.map(value => value.seq));
  }
});

test('Qwen idle clearing retains assistant and protected-role images without consuming user media retention', async () => {
  const image = id => ({ type: 'image', attachment: { id } });
  const system = entry('system', '', { content: [image('system-image')] });
  const developer = entry('developer', '', { content: [image('developer-image')] });
  const assistant = entry('assistant', '', { content: [image('assistant-image')] });
  const user = entry('user', '', { content: [image('old-user-image'), image('recent-user-image')] });
  const state = hostFor([system, developer, assistant, user, entry('assistant')]);
  await qwenPipeline({ keepRecentTools: 1 }).run(state.host, 'pressure');
  for (const protectedEntry of [system, developer, assistant]) assert.deepEqual(state.visible().find(value => value.seq === protectedEntry.seq), protectedEntry);
  const content = state.visible().find(value => value.seq === user.seq).message.content;
  assert.equal(content[0].type, 'text');
  assert.deepEqual(content[1], image('recent-user-image'));
});
