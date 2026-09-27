/** Check generated overlays against a local DSH checkout's actual shipped profile layers. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { createProfilePatch, parseProfileDump, stringifyProfilePatch } from './create-profile-patch.mjs';

const source = process.env.DSH_SOURCE_DIR;
if (!source) throw new Error('Set DSH_SOURCE_DIR to a deepseek-harness checkout before running test:profiles.');
const root = resolve(source);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
assert.equal(version, '0.1.7-rc.2', 'These plugins target DSH 0.1.7-rc.2.');
const require = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'));
const yaml = require('js-yaml');
const ids = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code', 'cline'];
const nativeEngine = '@deepseek-ai/dsh-compaction-basic';
const nativePruner = '@deepseek-ai/dsh-compaction-tool-result-pruner';
const command = '@deepseek-ai/dsh-command-compact';
const isEngine = entry => entry.name === nativeEngine || ids.some(id => entry.name === `dsh-context-${id}`);
const readYaml = file => yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema });

function bundle(directory) {
  const dir = join(root, directory);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const files = manifest.dsh.bundle.patch;
  return (Array.isArray(files) ? files : [files]).flatMap(file => readYaml(join(dir, file)));
}

function compose(entries, patches) {
  const warnings = [];
  const result = applyEntryPatches(entries, structuredClone(patches), (message, ...args) => warnings.push({ message, args }));
  assert.deepEqual(warnings, [], 'Every configuration patch must match.');
  return result;
}

function activeRows(entries) {
  return entries.flatMap(entry => {
    if (entry.disabled === true) return [];
    const children = entry.group && Array.isArray(entry.config) ? entry.config
      : entry.name === '@deepseek-ai/dsh-agent-preset' ? entry.config.plugins : [];
    return [entry, ...activeRows(children)];
  });
}

const base = bundle('packages/bundle/base');
const profiles = {
  headless: compose([], [...base, ...bundle('packages/bundle/headless')]),
  web: compose([], [...base, ...bundle('packages/bundle/web-app')]),
};

for (const id of ids) {
  for (const [profile, entries] of Object.entries(profiles)) {
    test(`${id}: ${profile} shipped profile replaces every active native compaction engine`, t => {
      const manifestUrl = new URL(`../packages/${id}/package.json`, import.meta.url);
      const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
      const files = manifest.dsh.bundle.patch;
      const patches = (Array.isArray(files) ? files : [files]).flatMap(file => readYaml(new URL(file, manifestUrl)));
      const installed = compose(entries, patches);
      assert.deepEqual(installed, entries, 'Package installation alone must preserve existing profile scopes.');
      const before = activeRows(entries);
      const expectedEngines = profile === 'headless' ? 1 : 3;
      assert.equal(before.filter(row => row.name === nativeEngine).length, expectedEngines);
      const patch = createProfilePatch(parseProfileDump(stringifyProfilePatch(installed)), id);
      const serialized = stringifyProfilePatch(patch);
      const parsed = yaml.load(serialized, { schema: entryListSchema });
      assert.deepEqual(parsed, patch, 'The actual DSH YAML parser must preserve every generated value.');
      const after = compose(installed, parsed);
      const active = activeRows(after);
      assert.equal(active.filter(row => row.name === nativeEngine).length, 0);
      assert.equal(active.filter(row => row.name === nativePruner).length, 0);
      assert.equal(active.filter(row => row.name === manifest.name).length, expectedEngines);
      assert.equal(active.filter(isEngine).length, expectedEngines);
      assert.deepEqual(active.filter(row => row.name === command), before.filter(row => row.name === command));
      if (profile === 'web') {
        const presets = after.filter(row => row.name === '@deepseek-ai/dsh-agent-preset');
        assert.equal(presets.length, 4);
        assert.deepEqual(presets.find(row => row.config.id === 'minimal'), entries.find(row => row.id === 'preset-minimal'));
        for (const preset of presets.filter(row => row.config.id !== 'minimal')) {
          const group = preset.config.plugins.find(row => row.id === 'compaction');
          assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true });
          assert.equal(activeRows(group.config).filter(row => row.name === manifest.name).length, 1);
        }
      }
      assert.deepEqual(compose(after, createProfilePatch(after, id)), after);
      const nextId = ids[(ids.indexOf(id) + 1) % ids.length];
      const switched = activeRows(compose(after, createProfilePatch(after, nextId)));
      assert.equal(switched.filter(row => row.name === `dsh-context-${nextId}`).length, expectedEngines);
      assert.equal(switched.filter(row => row.name === manifest.name).length, 0);
      t.diagnostic(`${expectedEngines} engine(s) replaced; native engine/pruner inactive; /compact retained; switch verified.`);
    });
  }
}
