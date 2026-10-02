# Desktop upgrade

English | [中文](desktop-upgrade.zh.md)

## Summary

Aspera `0.1.1` retains the existing Harness home and external plugin management. Fully quit the old application, use the complete new application directory and run `win-unpacked/Aspera.exe`. Each build has a distinct identifier and SHA-256 in `aspera-desktop-build.json`; `resources/build-info.json` travels with the application. Application numbering does not rewrite historical `0.2.0` receipts or change the desktop profile ownership marker.

## Contents

- [Profile changes](#profile-changes)

-----

<a id="profile-changes"></a>
## Profile changes

The profile ownership marker advances from version 1 to 2. Upgrade validates the old package junction before unlinking it, backs up `cordis.patch.yml` as `cordis.patch.v1.yml`, removes application-generated management restrictions, and separates the application overlay from user settings. A changed junction or unowned package directory stops startup for inspection. Existing experiment, credential, workspace and Session stores are retained.

External packages are installed in the writable profile; the fixed runtime lives in `runtime.asar`. Restart after installing or changing a plugin. Runtime file watching remains disabled. Do not run both versions against the same Harness home or reopen the legacy executable after profile upgrade.
