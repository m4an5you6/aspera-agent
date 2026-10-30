# Desktop upgrade

English | [中文](desktop-upgrade.zh.md)

## Summary

Aspera `0.1.1` retains the existing Harness home and external plugin management. Fully quit the old application, use the complete new application directory and run `win-unpacked/Aspera.exe`. Each build has a distinct identifier and SHA-256 in `aspera-desktop-build.json`; `resources/build-info.json` travels with the application. Application numbering does not rewrite historical `0.2.0` receipts or change the desktop profile ownership marker.

## Contents

- [Profile changes](#profile-changes)
- [Controller readiness](#controller-readiness)

-----

<a id="profile-changes"></a>
## Profile changes

The profile ownership marker advances from version 1 to 2. Upgrade validates the old package junction before unlinking it, backs up `cordis.patch.yml` as `cordis.patch.v1.yml`, removes application-generated management restrictions, and separates the application overlay from user settings. A changed junction or unowned package directory stops startup for inspection. Existing experiment, credential, workspace and Session stores are retained.

External packages are installed in the writable profile; the fixed runtime lives in `runtime.asar`. Restart after installing or changing a plugin. Runtime file watching remains disabled. Do not run both versions against the same Harness home or reopen the legacy executable after profile upgrade.

Matching desktop resources include the sealed deployment archive and verify it against installed extension files before creating experiments. Clearing the local pnpm metadata cache no longer prevents deployment from these resources. Source builds can fetch missing pinned package metadata. A failed preparation with no captured release or remote directories can be retried in place; existing fixed releases and submitted experiments keep their original identity. Update the resources only after fully quitting Aspera, retaining the original executable and the resource backup.

Before starting the Host, desktop fills a missing `name` in the profile's `package.json` with `aspera-desktop-profile` and a missing `version` with the desktop application's package version. Existing names, versions, dependencies, bundles and user patches are retained. Explicit empty or non-string identity fields stop startup for correction. The ownership marker stays at version 2. This allows the DeepSeek plugin inventory to identify the desktop lifecycle module; no request extension is disabled. Fully quit and reopen the updated application to apply the repair; existing conversations can be retried without copying experiments.

The runtime update also repairs DeepSeek phase snapshots. Preserve private configuration records and hashes, restart Aspera, and retry preparation when no release has been captured. Already fixed remote releases retain their original readers; see [model snapshot recovery](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-model-snapshots/guide.md).

-----

<a id="controller-readiness"></a>
## Controller readiness

The [storage-governance update](storage-governance.md#records-and-compatibility) also requires matching Host, runtime and Web resources. Prepare resources first, fully quit Aspera before applying them, and retain the original executable. Old remote experiments keep their sealed release; a copied experiment receives storage, historical borrowing and managed-material capabilities after confirmed release.

The [completion-review resource update](completion-review.md) reuses the existing executable. Fully quit Aspera before applying resources; preserve original fixed releases, failed outcomes and evidence files. Historical review needs no retraining and does not upgrade remote tasks.

The matching resource update adds GPU identity checks and preparation-owned idle controller repair while retaining the current executable. Keep original remote releases and submitted experiments. Controllers with unknown startup authorization or without safe maintenance support require the reported release/stop action; their sealed releases are not overwritten. Interrupted repairs retain independent receipts and their attempt limit. See the [controller readiness upgrade](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-controller-readiness/guide.md).
