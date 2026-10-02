# Aspera Desktop

English | [中文](README.zh.md)

## Summary

Manage Aspera experiments in a desktop window, reopen it from the Windows tray, and keep accepted remote experiments running after quitting. The Windows x64 local build packages its complete management runtime and needs no separate Node or pnpm installation.

## Contents

- [Run](#run)
- [Build and verify](#build-and-verify)
- [Implementation](#implementation)
- [Limits](#limits)

-----

<a id="run"></a>
## Run

Open `win-unpacked/Aspera.exe` and keep its complete application directory together. Configure the model in DSH and open **Aspera** in the sidebar. Server setup uses the [workspace guide](../../README.md#submit-an-experiment).

Closing the window hides it in the Windows tray and leaves the local management Host running. Tray and application menus reopen the window or quit. Quit waits for local Host disposal; accepted remote experiments and services remain remote. Local conversations and submissions without a handover still depend on this application.

Desktop stores its state under `%APPDATA%/Aspera`, with Harness data in `dsh`. Configure servers in this independent home. `ASPERA_DESKTOP_USER_DATA_DIR` selects another desktop state root; `ASPERA_HOME` selects another Harness home. Run only one management process against each Harness home.

Windows taskbar overlays show the number of experiments needing plan confirmation or a reply: `1–99`, then `99+`; zero clears the overlay. Hiding the window also updates the tray artwork. Counts refresh without opening Aspera. A fully exited application cannot update badges; restarting restores the count from durable remote state.

-----

<a id="build-and-verify"></a>
## Build and verify

Use the [workspace prerequisites](../../README.md#start-the-management-page), then run these commands from `extensions/aspera`.

```text
pnpm install --frozen-lockfile
pnpm run build:desktop
pnpm run test:desktop:api
pnpm run test:desktop
pnpm run start:desktop
```

Outputs are `.artifacts/desktop-0.1.1/<build-id>/win-unpacked/Aspera.exe` and `aspera-desktop-build.json`; no ZIP is generated; `latest.json` points to the latest successful build. The record contains executable/runtime SHA-256, build ID, exact DSH/Aspera/Electron versions, protocol/storage generations and remote release digest. The application embeds `resources/build-info.json`. Staging uses `.artifacts/desktop-build-*`; initial dependency downloads require network access.

Desktop verification uses the latest build by default; `ASPERA_DESKTOP_BUILD_ID` selects a particular build directory.

For an interrupted build, `ASPERA_DESKTOP_STAGE=.artifacts/desktop-build-<id>` reuses that staging directory only when its frozen release digest still matches the current build. The build rechecks the production lockfile and reseals the runtime; completed output directories remain separate.

The packaged smoke uses a private home, verifies the official caption and typography, installs a local bundle through the real Plugins page and checks activation after restart. It also checks generation of complete deployment materials from the archived runtime, native shortcuts, menu dismissal, renderer isolation, tray visibility and joined Host shutdown. `node scripts/measure-desktop.mjs --runs=3 --assert-fixed` records first-window, application-document and usable-page timings in `.artifacts/desktop/startup-measurement.json` and a version-specific report. Each sample uses a fresh home and a model-key presence fixture without executing a model task. File caching and Windows startup variability remain part of these measurements. See [verification](../../docs/verification.md) for Web, scheduling and GPU coverage. `ASPERA_DESKTOP_STARTUP_MS` and `ASPERA_DESKTOP_SHUTDOWN_MS` default to 60000 and 30000 milliseconds and accept integers from 1000 to 2147483647.

-----

<a id="implementation"></a>
## Implementation

Electron owns the window and tray. Its Node-mode child runs the named `aspera-desktop` profile through the published DSH profile runner. No upstream Desktop source is imported. Browser authentication exchanges a private launch token for a cookie. The sandboxed renderer has no Node integration; its isolated adapter provides appearance, application/Edit menus and the published Desktop shortcut protocol, with atomic device preferences. Onboarding queries only model credential presence through authenticated RPC. Native operations validate the owned top frame. Navigation stays on the owned loopback origin, credential-free HTTPS links open externally, and browser permissions default to denied.

`runtime.asar` carries frozen production packages and pnpm; native binaries and pnpm remain unpacked. The writable profile holds external plugin dependencies and selections. DSH’s shared resolver uses a combined runtime manifest that explicitly lists Aspera packages and official optional DSH bundles. Packaging copies the optional bundle names and versions from the pinned DSH installation. The user directory needs no source checkout or second core installation. Plugins install with bundled pnpm; activation changes take effect after restart while file-watcher HMR stays disabled. Application overlays are separate from user patches. Legacy configuration is backed up before its verified runtime link and application-generated management restrictions are removed; see [upgrade instructions](../../docs/desktop-upgrade.md). Framework environments remain remote, and the published browse picker provides directory selection.

The [architecture diagrams](../../docs/architecture.md#architecture-diagrams) show module ownership and handover. Policy and profile tests reject invalid IPC URLs, unsafe navigation, credential-bearing links and changed ownership. Private IPC invokes the CLI's graceful signal handler on Windows, and the shell waits for the Host to exit.

-----

<a id="limits"></a>
## Limits

This is an unsigned Windows x64 application directory, without an installer, update feed or publication. macOS and Linux packages are not qualified. The carrier reuses DSH client account, onboarding and settings pages; it does not include upstream Desktop’s native Account window, automatic updates or embedded Platform browser. GPU training and multi-node synchronization need separate GPU acceptance.
