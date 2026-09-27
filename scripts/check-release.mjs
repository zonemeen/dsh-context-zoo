/** Pack and verify the actual npm artifacts without contacting the registry. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x as extract } from 'tar';
import { valid } from 'semver';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(rootManifest.private, true, 'Only packages/* may be published.');
assert.equal(valid(rootManifest.version), rootManifest.version);
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run this check through pnpm release:check.');
const output = join(root, '.artifacts/npm');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'context-zoo-pack-'));
try {
  const entries = await readdir(join(root, 'packages'), { withFileTypes: true });
  const packages = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const cwd = join(root, 'packages', entry.name);
    return { cwd, manifest: JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) };
  }));
  const core = packages.find(entry => entry.manifest.name === 'dsh-context-core');
  assert.ok(core, 'The shared core must be included in the release.');
  for (const { cwd, manifest } of packages) {
    assert.equal(manifest.version, rootManifest.version, 'Publish all packages at the same version.');
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/');
    const packed = spawnSync(process.execPath, [pnpm, 'pack', '--json', '--pack-destination', output], { cwd, encoding: 'utf8' });
    if (packed.error) throw packed.error;
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const info = JSON.parse(packed.stdout);
    const paths = new Set(info.files.map(file => file.path));
    for (const file of ['package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'dist/index.js', 'dist/index.d.ts']) assert.ok(paths.has(file), `${manifest.name}: missing ${file}`);
    for (const file of paths) assert.ok(!/(^|\/)(?:\.env(?:\.[^/]*)?|node_modules|tests|reports|\.tsbuildinfo)(?:\/|$)/.test(file), `Unexpected package content: ${file}`);
    const unpacked = join(scratch, manifest.name);
    await mkdir(unpacked);
    await extract({ file: resolve(info.filename), cwd: unpacked, strip: 1 });
    const published = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const value of Object.values(published[section] ?? {})) assert.ok(!/^(workspace|link|file):/.test(value), `${manifest.name}: local dependency escaped into the tarball`);
    }
    if (manifest.name !== core.manifest.name) {
      assert.equal(published.dependencies[core.manifest.name], `^${core.manifest.version}`);
      assert.deepEqual(published.dsh.bundle.patch, []);
    } else {
      const bin = published.bin['dsh-context-patch'];
      assert.ok(paths.has(bin.replace(/^\.\//, '')));
      for (const name of ['README.md', 'README.zh-CN.md', 'DSH-LICENSE', '@deepseek-ai__dsh-session@0.1.7-rc.2.patch', 'dsh-session-source.patch']) await access(join(unpacked, 'dist/compat', name));
      // Resolve the CLI's external YAML dependency while keeping its own code in the unpacked artifact.
      await symlink(join(root, 'node_modules'), join(unpacked, 'node_modules'), 'junction');
      const input = join(scratch, 'profile.yml');
      await writeFile(input, '- id: compaction-basic\n  name: "@deepseek-ai/dsh-compaction-basic"\n');
      const cli = spawnSync(process.execPath, [join(unpacked, bin), 'codex', input], { encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /dsh-context-codex/);
    }
    process.stdout.write(`Packed ${manifest.name}@${manifest.version}: ${paths.size} files verified.\n`);
  }
  process.stdout.write(`Ready-to-inspect tarballs: ${output}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
