# Publishing to npm

English | [简体中文](publishing.zh-CN.md)

Run maintainer commands from the repository root with Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` and pnpm `11.9.0`. The root package stays private. The nine public packages share one version:

- `dsh-context-core`
- `dsh-context-claude-code`
- `dsh-context-codex`
- `dsh-context-opencode`
- `dsh-context-pi`
- `dsh-context-qwen-code`
- `dsh-context-zcode`
- `dsh-context-kimi-code`
- `dsh-context-cline`

The unscoped names require no npm organization. Your npm account must have permission to publish each name. Registry availability can change before the first release. Published packages retain their Node.js requirement of `^22.19.0 || >=24.0.0`.

## Choose a publishing route

| Command | Behavior |
| --- | --- |
| `pnpm release` | Select a version, check, commit, tag, and push; GitHub Actions publishes. |
| `pnpm release:local` | Select a version, check, commit, and tag; publish from this machine and keep Git changes local. |
| `pnpm release:publish` | Check and retry publishing the current tagged version from this machine. |

Both publishing routes use `latest` for stable versions and `next` for prereleases. Choose one route for each version.

## GitHub Actions setup

1. Create an npm granular access token with package read/write access, permission to publish all nine names, and **Bypass two-factor authentication** enabled for unattended publishing. For the first release, its permissions must allow creating new packages. See [npm's CI authentication guide](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/).
2. Add it as the repository Actions secret **`NPM_TOKEN`** in [Settings → Secrets and variables → Actions](https://github.com/zonemeen/dsh-context-zoo/settings/secrets/actions). Keep the value in GitHub Secrets; do not put it in repository files or command arguments. Renew it before expiry.
3. Commit and push the release configuration, workflow, and package changes to `main`. The local `main` branch must track `origin/main`, and your Git credentials must permit pushing commits and tags. Repository branch rules must allow the release commit to be pushed to `main`.

The Actions route uses local Git credentials and the GitHub `NPM_TOKEN` secret; local npm login is not required. The local route below uses your machine's npm login. Neither route needs a DeepSeek API key.

## Check and preview

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm release --dry-run
```

`release:check` builds all packages, runs keyless tests, packs the nine npm archives into `.artifacts/npm/`, and inspects their contents. It checks matching versions, built entry points, licenses, README files, converted workspace dependency ranges, and the packaged profile generator. CI and the publishing workflow run the same check. Packing does not publish anything.

The core archive includes `dsh-context-patch` and the Session compatibility files in `dist/compat/`. Sources accompany source maps. Repository tests, reports, and build-state files are excluded from the archives.

`--dry-run` previews the selected version and planned commands without changing versions, committing, tagging, or pushing. It skips the release-check hook, so run `release:check` separately when checking artifacts.

## Release through GitHub Actions

Start from a clean `main` branch with committed changes and an up-to-date `origin/main`:

```sh
pnpm release
```

Select patch, minor, major, prerelease, or a custom version in the terminal. After version selection, the command automatically:

1. Updates the root and nine package manifests, preserving `workspace:^` references.
2. Runs `pnpm release:check` against the selected version.
3. Creates a `chore: release v<version>` commit and an annotated `v<version>` tag.
4. Pushes `main` and that tag to `origin` in one atomic push. If either update is rejected, neither is pushed.

To publish the current initial version `0.1.0` without incrementing it:

```sh
pnpm release --no-increment
```

This still runs the checks and creates the release tag; a version-only commit is unnecessary when no files change. To specify a version directly, use `pnpm release 0.2.0-beta.1`.

## GitHub Actions publication

Pushing a `v*` tag starts [Publish npm](../.github/workflows/publish.yml). The job checks that the tag matches the root version and its commit belongs to `main`, runs the release checks, uploads the nine verified archives as a workflow artifact, and publishes packages in dependency order: core before the eight plugins. The private root is skipped. Stable versions use npm's `latest` tag; prereleases use `next`.

The publish step alone receives `NPM_TOKEN`. All packages use the official npm registry with public access. pnpm converts `workspace:^` into the corresponding published core version range. Follow the result in the repository's [Actions page](https://github.com/zonemeen/dsh-context-zoo/actions/workflows/publish.yml); a successful local push starts the job but does not confirm npm publication.

If local checks fail, nothing is pushed; inspect any remaining version edits before retrying. If the atomic push fails, inspect the local release commit and tag and resolve the Git error before pushing them. Existing tags are rejected by `pnpm release` and must not be moved to retry a publication. If an Actions job fails or publishes only some packages, fix the external cause such as an expired token and rerun that job: pnpm skips versions already published and continues with the remaining packages. A code or workflow fix requires a new version and tag. Published npm versions cannot be overwritten.

## Publish from your machine

Commit the setup changes before releasing. Start on a clean `main` branch that tracks `origin/main`, with current dependencies installed. Log in to the official npm registry using an account that can publish all nine package names:

```sh
npm login --registry=https://registry.npmjs.org/
pnpm release:local
```

Select the version in the terminal. The command uses the same version updates and release checks as the Actions route, creates a local release commit and tag, then publishes all nine packages in dependency order using your npm login. npm authentication prompts and registry errors appear directly in the terminal; complete any requested verification there. GitHub's `NPM_TOKEN` secret is not needed. The command fetches Git state for validation but does not push commits or tags.

For the first `0.1.0` release, or to preview the local route:

```sh
pnpm release:local --no-increment
pnpm release:local --dry-run
```

With `--no-increment`, an empty changeset and “No changes to commit” are expected: the existing commit is tagged.

Run the preview before the actual release if needed; it skips publication and the release-check hook. An explicit version is also supported, for example `pnpm release:local 0.2.0-beta.1`.

If local npm publication fails or completes only some packages, keep the release commit and tag, resolve the authentication or network error, then retry:

```sh
pnpm release:publish
```

This reruns the checks and publishes the current version, skipping package versions already on npm. It requires a clean `main` branch with `HEAD` at the matching `v<version>` tag; it does not change versions or create Git refs. `pnpm release:publish --dry-run` checks and previews publishing the already tagged version without uploading packages. Do not change the contents of an existing release to retry it; code changes need a new version.

After a successful local publication, push the version commit with `git push origin main`. Keep the release tag local to avoid starting Actions. Pushing any `v*` tag, including one created locally, starts the existing publishing workflow; avoid running both publishers at the same time.

## Using the published packages

After publishing, a user can install a plugin by its npm name. The actual DSH host still needs the [Session compatibility patch](../patches/README.md); publishing the package does not apply that host patch automatically.

```sh
dsh plugin --profile web add dsh-context-pi@0.1.0
dsh --profile web --dump-config > /tmp/dsh-web.yml
pnpm --package=dsh-context-core@0.1.0 dlx dsh-context-patch pi /tmp/dsh-web.yml > /tmp/dsh-web-pi.patch.yml
dsh --profile web --patch /tmp/dsh-web-pi.patch.yml
```

Use matching released plugin and core versions. Replace `pi` with the desired agent id. The generator reads the exported configuration and prints an overlay; it does not edit the host or profile. [Installation and activation](../README.md#use-with-dsh) covers persistent configuration and switching plugins.

The core package exports the compatibility files under `dsh-context-core/compat/*`. Its tarball also provides them directly:

```sh
npm pack dsh-context-core@0.1.0
tar -xzf dsh-context-core-0.1.0.tgz package/dist/compat
```

Read `package/dist/compat/README.md` before applying the patch to the actual DSH installation.
