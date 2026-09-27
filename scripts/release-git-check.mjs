/** Check clean input, branch ancestry, and unused tags before release-it changes versions. */
import { spawnSync } from 'node:child_process';
import { valid } from 'semver';

const git = args => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
};
try {
  const tag = process.argv[2];
  if (!tag) {
    const status = git(['status', '--porcelain']);
    if (status.status !== 0) throw new Error(status.stderr);
    if (status.stdout.trim()) throw new Error('Commit or stash pending changes, including untracked files, before running pnpm release.');
  } else {
    const version = tag.slice(1);
    if (tag !== `v${version}` || valid(version) !== version || version.includes('+')) throw new Error('Release tags must be v<semver>, without build metadata.');
    const ancestry = git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
    if (ancestry.status !== 0) throw new Error('Update main from origin/main before releasing.');
    const local = git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
    if (local.status === 0) throw new Error(`${tag} already exists locally. Rerun its GitHub Actions job or choose a new version.`);
    if (local.status !== 1) throw new Error(local.stderr || 'Could not inspect local tags.');
    const remote = git(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`]);
    if (remote.status === 0) throw new Error(`${tag} already exists on origin. Rerun its GitHub Actions job or choose a new version.`);
    if (remote.status !== 2) throw new Error(remote.stderr || 'Could not inspect remote tags.');
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
