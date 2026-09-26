# DSH Session Compatibility Patch

English | [简体中文](README.zh-CN.md)

DSH `0.1.7-rc.2` can restore external plugin events marked `ignorable: true`, but `Session.append()` does not expose an argument for writing that marker. Context plugins need durable failure counts, file lists, and auxiliary model-call records so these values survive session restoration.

This patch allows non-message events to call `append(type, data, { ignorable: true })` and writes the marker into the event envelope. It leaves the session format version, existing events, and compaction algorithms unchanged. Model-visible changes still use standard DSH message and compaction events.

## This repository

`pnpm-workspace.yaml` declares the published-package patch in `patchedDependencies`. Running `pnpm install` applies it automatically. Tests use DSH's `validateStoredEvents()` to check that the resulting records can be restored.

## The actual DSH host

**Apply the patch to the DSH runtime that creates the actual sessions.** Patching this library's development dependency does not patch a separate host installation. The plugin probes both its imported Session class and the active session implementation in isolation; these probes do not write to user sessions.

For a DSH host installed through a pnpm project, copy `@deepseek-ai__dsh-session@0.1.7-rc.2.patch` from this directory into that project's `patches/` directory. Merge the following entry into its `pnpm-workspace.yaml`, then run `pnpm install`:

```yaml
patchedDependencies:
  '@deepseek-ai/dsh-session@0.1.7-rc.2': patches/@deepseek-ai__dsh-session@0.1.7-rc.2.patch
```

When running DSH from its source workspace, the published-package patch does not change workspace source. Check and apply `dsh-session-source.patch` from the DSH repository root, then rebuild according to DSH's development instructions. The patch targets the source location used by this library's pinned version. Run `git apply --check <absolute-patch-path>` first to confirm that it applies to your checkout.

This repository does not automatically modify a user's DSH installation or profile. If the host lacks the patch, the plugin rejects workflows that require durable records and reports the reason. Once DSH exposes this parameter publicly, the patch can be removed when updating the pinned dependency version.

The patch includes a small amount of DSH context code under the [MIT license](DSH-LICENSE).
