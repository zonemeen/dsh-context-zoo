/** Validate the Actions tag against the checked-out version and main before npm publication. */
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { valid, prerelease } from 'semver';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (valid(version) !== version || version.includes('+') || process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('The release tag must match the exact package.json version.');
}
execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'inherit' });
const tag = prerelease(version) ? 'next' : 'latest';
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required. Run this validation in GitHub Actions.');
await appendFile(process.env.GITHUB_OUTPUT, `npm-tag=${tag}\n`);
process.stdout.write(`Validated v${version}; npm distribution tag: ${tag}.\n`);
