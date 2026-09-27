import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const ids = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code', 'cline'];
for (const id of ['core', ...ids]) {
  const root = new URL(`../packages/${id}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'README.md', 'README.zh-CN.md']) await access(new URL(path, root));
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.files.includes('README.md'));
  assert.ok(manifest.files.includes('README.zh-CN.md'));
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-fs'], '0.1.7-rc.2');
  if (id === 'core') continue;
  assert.deepEqual(manifest.dsh.bundle.patch, [], 'Installing a dependency must not mount an engine in the wrong profile scope.');
  const plugin = await import(new URL('dist/index.js', root));
  assert.equal(plugin.strategy.id, id);
  assert.equal(typeof plugin.default.apply, 'function');
  assert.equal(typeof plugin.createPipeline, 'function');
  const pipeline = plugin.createPipeline();
  assert.equal(typeof pipeline.run, 'function');
  assert.equal(typeof pipeline.summarizeRange, 'function');
}
console.log('All nine packages have built exports, licenses, and valid DSH bundle declarations.');
