/** Exercise release configuration with local Git remotes and no npm publication. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const releaseBin = join(root, 'node_modules/release-it/bin/release-it.js');
const ids = ['core', 'claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code'];
// Fixture manifests intentionally have no install; pnpm 11 must not repair their linked dependencies.
const environment = { ...process.env, CI: 'true', PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false', pnpm_config_verify_deps_before_run: 'false', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: environment }).trim();

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'context-zoo-git-release-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, 'repo');
  const remote = join(scratch, 'origin.git');
  await mkdir(cwd);
  git(scratch, 'init', '--bare', '--initial-branch=main', remote);
  git(cwd, 'init', '--initial-branch=main');
  for (const [name, value] of [['user.name', 'Release Test'], ['user.email', 'release@example.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.hooksPath', join(scratch, 'hooks')]]) git(cwd, 'config', name, value);
  await writeFile(join(cwd, '.gitignore'), 'node_modules/\n.artifacts/\n');
  for (const file of ['.release-it.json', '.release-it.local.json']) {
    await copyFile(join(root, file), join(cwd, file));
  }
  await mkdir(join(cwd, 'scripts'));
  for (const file of ['release-git-check.mjs', 'publish-local.mjs', 'local-publish-plugin.mjs']) {
    await copyFile(join(root, 'scripts', file), join(cwd, 'scripts', file));
  }
  await mkdir(join(cwd, 'node_modules/@release-it'), { recursive: true });
  for (const name of ['semver', '@release-it/bumper', 'release-it']) {
    await symlink(join(root, 'node_modules', name), join(cwd, 'node_modules', name), 'junction');
  }
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'release-fixture', version: '0.1.0', private: true, type: 'module', scripts: { 'release:check': 'node verify-release.mjs' } }, null, 2) + '\n');
  for (const id of ids) {
    await mkdir(join(cwd, 'packages', id), { recursive: true });
    await writeFile(join(cwd, 'packages', id, 'package.json'), JSON.stringify({ name: `dsh-context-${id}`, version: '0.1.0', ...id === 'core' ? {} : { dependencies: { 'dsh-context-core': 'workspace:^' } } }, null, 2) + '\n');
  }
  await writeFile(join(cwd, 'verify-release.mjs'), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const version = read('package.json').version;
for (const id of ${JSON.stringify(ids)}) assert.equal(read('packages/' + id + '/package.json').version, version);
if (process.env.FAIL_RELEASE_CHECK) throw new Error('Deliberate release check failure');
fs.mkdirSync('.artifacts', { recursive: true });
fs.writeFileSync('.artifacts/verified-version', version);
if (process.env.ADVANCE_RELEASE_REMOTE) {
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const remote = git(['remote', 'get-url', 'origin']);
  const previous = git(['rev-parse', 'origin/main']);
  const tree = git(['rev-parse', 'origin/main^{tree}']);
  const next = git(['--git-dir', remote, 'commit-tree', tree, '-p', previous, '-m', 'Concurrent remote change']);
  git(['--git-dir', remote, 'update-ref', 'refs/heads/main', next, previous]);
}
`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'Initial fixture');
  git(cwd, 'remote', 'add', 'origin', remote);
  git(cwd, 'push', '--set-upstream', 'origin', 'main');
  return { cwd, remote, initial: git(cwd, 'rev-parse', 'HEAD') };
}

function release(cwd, args, env = {}, input) {
  return spawnSync(process.execPath, [releaseBin, '--only-version', '--ci', ...args], { cwd, env: { ...environment, ...env }, encoding: 'utf8', timeout: 60_000, input });
}
const log = result => `${result.stdout}\n${result.stderr}`;
const remoteTag = f => git(f.cwd, 'ls-remote', '--tags', 'origin');

for (const [version, npmTag] of [['0.1.1', 'latest'], ['0.2.0-beta.1', 'next']]) {
  test(`release ${version} updates all manifests, checks them, and pushes one matching tag`, async t => {
    const f = await fixture(t);
    const result = release(f.cwd, [version]);
    assert.equal(result.status, 0, log(result));
    assert.equal(await readFile(join(f.cwd, '.artifacts/verified-version'), 'utf8'), version);
    for (const id of ids) {
      const manifest = JSON.parse(git(f.cwd, '--git-dir', f.remote, 'show', `main:packages/${id}/package.json`));
      assert.equal(manifest.version, version);
      if (id !== 'core') assert.equal(manifest.dependencies['dsh-context-core'], 'workspace:^');
    }
    const remoteHead = git(f.cwd, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main');
    assert.equal(git(f.cwd, '--git-dir', f.remote, 'rev-parse', `refs/tags/v${version}^{}`), remoteHead);
    const output = join(f.cwd, '.artifacts/actions-output');
    const validation = spawnSync(process.execPath, [join(root, 'scripts/check-release-tag.mjs')], { cwd: f.cwd, encoding: 'utf8', env: { ...environment, GITHUB_REF_NAME: `v${version}`, GITHUB_OUTPUT: output } });
    assert.equal(validation.status, 0, log(validation));
    assert.equal(await readFile(output, 'utf8'), `npm-tag=${npmTag}\n`);
    const mismatch = spawnSync(process.execPath, [join(root, 'scripts/check-release-tag.mjs')], { cwd: f.cwd, encoding: 'utf8', env: { ...environment, GITHUB_REF_NAME: 'v9.9.9', GITHUB_OUTPUT: output } });
    assert.notEqual(mismatch.status, 0);
    assert.match(log(mismatch), /must match/);
  });
}

test('first release can tag the current version without changing versions', async t => {
  const f = await fixture(t);
  const result = release(f.cwd, ['--no-increment']);
  assert.equal(result.status, 0, log(result));
  assert.equal(git(f.cwd, '--git-dir', f.remote, 'rev-parse', 'refs/tags/v0.1.0^{}'), f.initial);
});

test('untracked files stop a release before versions are changed', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'pending.txt'), 'Do not include this file.\n');
  const result = release(f.cwd, ['0.1.1']);
  assert.notEqual(result.status, 0);
  assert.match(log(result), /untracked files/);
  assert.equal(JSON.parse(await readFile(join(f.cwd, 'package.json'), 'utf8')).version, '0.1.0');
  assert.equal(remoteTag(f), '');
});

test('a failing release check publishes no commit or tag', async t => {
  const f = await fixture(t);
  const result = release(f.cwd, ['0.1.1'], { FAIL_RELEASE_CHECK: '1' });
  assert.notEqual(result.status, 0);
  assert.match(log(result), /Deliberate release check failure/);
  assert.equal(git(f.cwd, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), f.initial);
  assert.equal(remoteTag(f), '');
});

test('an existing release tag is preserved and cannot trigger another release', async t => {
  const f = await fixture(t);
  git(f.cwd, 'tag', '-a', 'v0.1.0', '-m', 'Existing release');
  git(f.cwd, 'push', 'origin', 'refs/tags/v0.1.0');
  const before = remoteTag(f);
  const result = release(f.cwd, ['--no-increment']);
  assert.notEqual(result.status, 0);
  assert.match(log(result), /already exists/);
  assert.equal(remoteTag(f), before);
});

test('a concurrent remote commit rejects the atomic push without publishing the tag', async t => {
  const f = await fixture(t);
  const result = release(f.cwd, ['0.1.1'], { ADVANCE_RELEASE_REMOTE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(log(result), /atomic push failed|fetch first/);
  assert.notEqual(git(f.cwd, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), f.initial);
  assert.equal(remoteTag(f), '');
});

test('a dry run leaves versions, commits, and remote tags unchanged', async t => {
  const f = await fixture(t);
  const result = release(f.cwd, ['0.1.1', '--dry-run']);
  assert.equal(result.status, 0, log(result));
  assert.equal(JSON.parse(await readFile(join(f.cwd, 'package.json'), 'utf8')).version, '0.1.0');
  for (const id of ids) assert.equal(JSON.parse(await readFile(join(f.cwd, 'packages', id, 'package.json'), 'utf8')).version, '0.1.0');
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.initial);
  assert.equal(git(f.cwd, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), f.initial);
  assert.equal(git(f.cwd, 'tag', '--list'), '');
  assert.equal(remoteTag(f), '');
});

test('Actions rejects a matching version on a commit outside main', async t => {
  const f = await fixture(t);
  git(f.cwd, 'switch', '-c', 'unreleased');
  await writeFile(join(f.cwd, 'unreleased.txt'), 'Unreleased change.\n');
  git(f.cwd, 'add', 'unreleased.txt');
  git(f.cwd, 'commit', '-m', 'Unreleased change');
  const validation = spawnSync(process.execPath, [join(root, 'scripts/check-release-tag.mjs')], {
    cwd: f.cwd,
    encoding: 'utf8',
    env: { ...environment, GITHUB_REF_NAME: 'v0.1.0', GITHUB_OUTPUT: join(f.cwd, 'actions-output') },
  });
  assert.notEqual(validation.status, 0, log(validation));
});

async function localPublisher(f) {
  await mkdir(join(f.cwd, '.artifacts'), { recursive: true });
  const stub = join(f.cwd, '.artifacts/pnpm-stub.mjs');
  await writeFile(stub, `
import { readFileSync, writeFileSync } from 'node:fs';
if (process.env.EXPECT_NPM_INPUT) {
  const input = readFileSync(0, 'utf8');
  if (input !== process.env.EXPECT_NPM_INPUT) throw new Error('Publisher could not read terminal input.');
  process.stdout.write('Publisher received terminal input.');
}
writeFileSync('.artifacts/publish-args.json', JSON.stringify(process.argv.slice(2)));
if (process.env.FAIL_NPM_PUBLISH) {
  process.stdout.write('ERR_NPM_TEST: The registry rejected this test publication.');
  process.exit(1);
}
`);
  return { npm_execpath: stub };
}

for (const [version, npmTag] of [['0.1.1', 'latest'], ['0.2.0-beta.1', 'next'], ['0.1.0', 'latest']]) {
  test(`local release ${version} checks and tags before publishing without pushing`, async t => {
    const f = await fixture(t);
    const env = await localPublisher(f);
    const result = release(f.cwd, [version === '0.1.0' ? '--no-increment' : version, '--config', '.release-it.local.json'], env);
    assert.equal(result.status, 0, log(result));
    assert.equal(await readFile(join(f.cwd, '.artifacts/verified-version'), 'utf8'), version);
    assert.equal(git(f.cwd, 'rev-parse', `refs/tags/v${version}^{}`), git(f.cwd, 'rev-parse', 'HEAD'));
    assert.equal(git(f.cwd, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), f.initial);
    assert.equal(remoteTag(f), '');
    const args = JSON.parse(await readFile(join(f.cwd, '.artifacts/publish-args.json'), 'utf8'));
    assert.equal(args[args.indexOf('--tag') + 1], npmTag);
    assert.equal(args[args.indexOf('--registry') + 1], 'https://registry.npmjs.org');
    assert.ok(args.includes('--recursive'));
    assert.ok(args.includes('--git-checks'));
  });
}

test('a failed local publication preserves the release commit and tag for retry', async t => {
  const f = await fixture(t);
  const env = await localPublisher(f);
  const result = release(f.cwd, ['0.1.1', '--config', '.release-it.local.json'], { ...env, FAIL_NPM_PUBLISH: '1' });
  assert.notEqual(result.status, 0, log(result));
  assert.match(log(result), /pnpm release:publish/);
  assert.match(log(result), /ERR_NPM_TEST: The registry rejected this test publication/);
  const head = git(f.cwd, 'rev-parse', 'HEAD');
  assert.notEqual(head, f.initial);
  assert.equal(git(f.cwd, 'rev-parse', 'refs/tags/v0.1.1^{}'), head);
  assert.equal(remoteTag(f), '');
  const retry = spawnSync(process.execPath, [join(f.cwd, 'scripts/publish-local.mjs')], {
    cwd: f.cwd, encoding: 'utf8', env: { ...environment, ...env },
  });
  assert.equal(retry.status, 0, log(retry));
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head);
});

test('local dry run neither publishes nor changes versions or Git refs', async t => {
  const f = await fixture(t);
  const env = await localPublisher(f);
  const result = release(f.cwd, ['0.1.1', '--config', '.release-it.local.json', '--dry-run'], env);
  assert.equal(result.status, 0, log(result));
  await assert.rejects(readFile(join(f.cwd, '.artifacts/publish-args.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(f.cwd, 'package.json'), 'utf8')).version, '0.1.0');
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.initial);
  assert.equal(git(f.cwd, 'tag', '--list'), '');
  assert.equal(remoteTag(f), '');
});

test('local publishing refuses a commit newer than the release tag', async t => {
  const f = await fixture(t);
  const env = await localPublisher(f);
  git(f.cwd, 'tag', '-a', 'v0.1.0', '-m', 'Initial release');
  git(f.cwd, 'commit', '--allow-empty', '-m', 'Unreleased change');
  const result = spawnSync(process.execPath, [join(f.cwd, 'scripts/publish-local.mjs')], {
    cwd: f.cwd, encoding: 'utf8', env: { ...environment, ...env },
  });
  assert.notEqual(result.status, 0);
  assert.match(log(result), /HEAD must match v0.1.0/);
  await assert.rejects(readFile(join(f.cwd, '.artifacts/publish-args.json')), { code: 'ENOENT' });
});

test('local npm authentication can read terminal input and display its output', async t => {
  const f = await fixture(t);
  const env = await localPublisher(f);
  const input = 'test-authentication-response';
  const result = release(f.cwd, ['0.1.1', '--config', '.release-it.local.json'], { ...env, EXPECT_NPM_INPUT: input }, input);
  assert.equal(result.status, 0, log(result));
  assert.match(log(result), /Publisher received terminal input/);
});
