/** Publish a checked, tagged release using local npm credentials. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { valid, prerelease } from 'semver';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--dry-run')) {
  throw new Error('Usage: pnpm release:publish [--dry-run]');
}
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (valid(version) !== version || version.includes('+')) throw new Error('A valid release version without build metadata is required.');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', `refs/tags/v${version}^{}`])) {
  throw new Error(`HEAD must match v${version}. Retry from the original release commit.`);
}
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run this command through pnpm release:local or pnpm release:publish.');
const tag = prerelease(version) ? 'next' : 'latest';
process.stdout.write(`Publishing v${version} from this machine with npm tag ${tag}.\n`);
const result = spawnSync(process.execPath, [
  pnpm, '--recursive', 'publish', '--access', 'public', '--tag', tag,
  '--git-checks', '--publish-branch', 'main', '--registry', 'https://registry.npmjs.org', '--report-summary', ...args,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write('Publication did not finish. Resolve the npm error, then run pnpm release:publish to retry this version.\n');
  process.exitCode = result.status ?? 1;
}
