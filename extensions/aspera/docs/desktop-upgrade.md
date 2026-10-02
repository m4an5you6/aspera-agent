# Desktop upgrade

English | [中文](desktop-upgrade.zh.md)

## Summary

Desktop 0.2 uses the existing Harness home and retains external plugin management. Fully quit the old application, keep the complete new application directory together and run `win-unpacked/Aspera.exe`. Builds produce the application directory without a ZIP.

## Contents

- [Profile changes](#profile-changes)

-----

<a id="profile-changes"></a>
## Profile changes

The profile ownership marker advances from version 1 to 2. Upgrade validates the old package junction before unlinking it, backs up `cordis.patch.yml` as `cordis.patch.v1.yml`, removes application-generated management restrictions, and separates the application overlay from user settings. A changed junction or unowned package directory stops startup for inspection. Existing experiment, credential, workspace and Session stores are retained.

External packages are installed in the writable profile; the fixed runtime lives in `runtime.asar`. Restart after installing or changing a plugin. Runtime file watching remains disabled. Do not run both versions against the same Harness home or reopen the legacy executable after profile upgrade.
