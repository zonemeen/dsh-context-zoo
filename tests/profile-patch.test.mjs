import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';
import { createProfilePatch, parseProfileDump, stringifyProfilePatch } from '../scripts/create-profile-patch.mjs';

const nativeName = '@deepseek-ai/dsh-compaction-basic';
const native = { id: 'compaction-basic', name: nativeName, config: { thresholdRatio: 0.8, nativeOnly: true } };
const pruner = { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192 } };
const command = { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' };
const compactionGroup = {
  id: 'compaction', name: 'cordis:group', group: true,
  isolate: { compaction: true, toolResultPruner: true },
  config: [native, command, pruner],
};
const preset = (id, plugins = [compactionGroup]) => ({
  id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset',
  config: { id, order: 1, name: 'My preset', plugins },
});

function applyPatches(entries, patches) {
  return applyEntryPatches(entries, patches, (message, ...args) => assert.fail(`${message}: ${args.join(', ')}`));
}

for (const id of ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code']) {
  test(`${id} replaces a host engine and disables its native pruner`, () => {
    const entries = [native, command, pruner];
    const original = structuredClone(entries);
    const result = applyPatches(entries, createProfilePatch(entries, id));
    assert.equal(result[0].disabled, true);
    assert.equal(result[2].disabled, true);
    assert.deepEqual(result[1], command);
    assert.equal(result[3].config[0].name, `dsh-context-${id}`);
    assert.deepEqual(result[3].config[0].config, {});
    assert.deepEqual(entries, original);
  });
}

test('updates complete preset configs once and preserves groups, commands, unrelated entries, and minimal', () => {
  const entries = [
    { ...native, disabled: true }, { ...pruner, disabled: true },
    preset('standard', [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Keep me' } }, compactionGroup]),
    preset('ptc'), preset('cordis'), preset('minimal', [command]),
    { ...preset('disabled'), disabled: true },
  ];
  const patches = createProfilePatch(entries, 'codex');
  assert.deepEqual(patches.map(patch => patch.id), ['preset-standard', 'preset-ptc', 'preset-cordis']);
  const result = applyPatches(entries, patches);
  assert.deepEqual(result.slice(0, 2), entries.slice(0, 2));
  assert.deepEqual(result.slice(5), entries.slice(5));
  assert.deepEqual(result[2].config.plugins[0], entries[2].config.plugins[0]);
  for (const row of result.slice(2, 5)) {
    assert.equal(row.config.name, 'My preset');
    const group = row.config.plugins.at(-1);
    assert.deepEqual(group.isolate, compactionGroup.isolate);
    assert.equal(group.config[0].name, 'dsh-context-codex');
    assert.deepEqual(group.config[1], command);
    assert.equal(group.config[2].disabled, true);
  }
});

test('rewrites nested groups under one complete outer config', () => {
  const entries = [{ id: 'outer', name: 'cordis:group', group: true, config: [compactionGroup, preset('inner')] }];
  const patches = createProfilePatch(entries, 'pi');
  assert.deepEqual(patches.map(patch => patch.id), ['outer']);
  const result = applyPatches(entries, patches);
  assert.equal(result[0].config[0].config[0].name, 'dsh-context-pi');
  assert.equal(result[0].config[1].config.plugins[0].config[0].name, 'dsh-context-pi');
});

test('reapplying a generated overlay is idempotent and switching retains shared config', () => {
  const original = [native, pruner];
  const firstPatch = createProfilePatch(original, 'pi');
  const first = applyPatches(original, firstPatch);
  first.at(-1).config[0].config = { auto: false, keepRecentTokens: 1000 };
  const repeated = applyPatches(first, createProfilePatch(first, 'pi'));
  assert.deepEqual(repeated, first);
  const switched = applyPatches(first, createProfilePatch(first, 'codex'));
  assert.equal(switched.length, first.length);
  assert.equal(switched.at(-1).config[0].name, 'dsh-context-codex');
  assert.deepEqual(switched.at(-1).config[0].config, { auto: false, keepRecentTokens: 1000 });
  assert.equal(switched[0].disabled, true);
});

test('preserves unevaluated DSH expressions through YAML round trips', () => {
  const entries = parseProfileDump(`
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:
      - id: tool-pwsh
        name: '@deepseek-ai/dsh-tool-pwsh'
        disabled: !!js process.platform !== 'win32'
        config:
          source: !!js ctx.fs
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
`);
  const patches = createProfilePatch(entries, 'codex');
  const text = stringifyProfilePatch(patches);
  assert.match(text, /!!js/);
  assert.deepEqual(parseProfileDump(text), patches);
  assert.deepEqual(patches[0].config.plugins[0], entries[0].config.plugins[0]);
});

test('does not disable a pruner in another scope without an engine', () => {
  const entries = [{ ...pruner, id: 'host-pruner' }, preset('standard')];
  const result = applyPatches(entries, createProfilePatch(entries, 'codex'));
  assert.deepEqual(result[0], entries[0]);
});

test('non-isolating groups share the parent compaction engine and pruning policy', () => {
  const entries = [
    { id: 'engine-group', name: 'cordis:group', group: true, config: [native, command] },
    { id: 'pruner-group', name: 'cordis:group', group: true, config: [pruner] },
  ];
  const result = applyPatches(entries, createProfilePatch(entries, 'codex'));
  assert.equal(result[0].config[0].name, 'dsh-context-codex');
  assert.equal(result[1].config[0].disabled, true);
  assert.throws(() => createProfilePatch([...entries, { ...native, id: 'another-engine' }], 'codex'), /more than one/);
});

test('named isolation shares service realms while distinct local isolation keeps engines separate', () => {
  const group = (id, isolate) => ({ id, name: 'cordis:group', group: true, isolate, config: [{ ...native, id: `${id}-engine` }] });
  assert.throws(() => createProfilePatch([group('one', { compaction: 'shared' }), group('two', { compaction: 'shared' })], 'codex'), /more than one/);
  const entries = [group('one', { compaction: true }), group('two', { compaction: true })];
  const result = applyPatches(entries, createProfilePatch(entries, 'codex'));
  assert.ok(result.every(row => row.config[0].name === 'dsh-context-codex'));
});

test('rejects duplicate ids in a loader tree before a nested entry can redirect a carrier patch', () => {
  const duplicateCarrier = { id: 'outer', name: 'cordis:group', group: true, config: [
    { ...compactionGroup, id: 'outer' },
  ] };
  assert.throws(() => createProfilePatch([duplicateCarrier], 'codex'), /Duplicate loader entry id: outer/);
  assert.throws(() => createProfilePatch([native, { ...compactionGroup, config: [{ ...native, disabled: true }] }], 'codex'), /Duplicate loader entry id: compaction-basic/);
  assert.throws(() => createProfilePatch([preset('one', [compactionGroup, { ...compactionGroup }])], 'codex'), /Duplicate loader entry id/);
  assert.doesNotThrow(() => createProfilePatch([preset('one'), preset('two')], 'codex'));
  assert.throws(() => createProfilePatch([native, { id: 'context-zoo-engine', name: 'unrelated' }], 'codex'), /already in use/);
});

test('rejects conditional ancestors and unisolated preset engines without evaluating expressions', () => {
  const disabled = { __jsExpr: 'throw new Error("must not evaluate")' };
  assert.throws(() => createProfilePatch([{ ...compactionGroup, disabled }], 'codex'), /conditionally disabled/);
  assert.throws(() => createProfilePatch([{ ...preset('one'), disabled }], 'codex'), /conditionally disabled/);
  assert.throws(() => createProfilePatch([preset('one', [native, command])], 'codex'), /require compaction isolation/);
});

test('rejects empty, disabled-only, invalid, conditional, and conflicting compositions', () => {
  for (const entries of [[], [{ ...native, disabled: true }], [{ ...preset('standard'), disabled: true }], [preset('minimal', [command])]]) {
    assert.throws(() => createProfilePatch(entries, 'codex'), /No active/);
  }
  assert.throws(() => createProfilePatch([native], 'unknown'), /Unknown context strategy/);
  assert.throws(() => parseProfileDump('config: nope'), /entry list/);
  assert.throws(() => createProfilePatch([native, { ...native, id: 'second' }], 'codex'), /more than one/);
  assert.throws(() => createProfilePatch([preset('standard', [{ ...compactionGroup, config: [native, { ...native, id: 'second' }] }])], 'codex'), /more than one/);
  assert.throws(() => createProfilePatch([{ ...native, disabled: { __jsExpr: 'true' } }], 'codex'), /conditionally disabled/);
  assert.throws(() => createProfilePatch([{ name: nativeName }], 'codex'), /needs an id/);
  assert.throws(() => createProfilePatch([native, { id: 'context-zoo', name: 'unrelated' }], 'codex'), /already in use/);
});

test('CLI emits an overlay and leaves its input file unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-zoo-patch-'));
  try {
    const file = join(dir, 'profile.yml');
    const source = stringifyProfilePatch([native, command, pruner]);
    await writeFile(file, source);
    const script = fileURLToPath(new URL('../scripts/create-profile-patch.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [script, 'codex', file], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    assert.equal(applyPatches([native, command, pruner], parseProfileDump(child.stdout)).at(-1).config[0].name, 'dsh-context-codex');
    assert.equal(await readFile(file, 'utf8'), source);
    const invalid = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
