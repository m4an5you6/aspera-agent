# Agent Note: Remove the Electron desktop application

Status: implemented

English | [中文](2026-09-21-remove-electron-desktop.zh.md)

## Problem

The repository shipped an Electron Desktop shell, a private Desktop Host, signed installers, and a reserved `$DSH_HOME/profiles/desktop` beside the Web, Headless, SDK, and ACP profiles. That product owned packaging, notarization, updater policy, Darwin and Windows window chrome, and a preload directory-picker bridge. Maintaining it split the interactive GUI across two carriers while the Web application already provided the same Host, RPC, and client plugins.

## Decision

The repository excludes `apps/desktop`, `apps/desktop-host`, the Electron osx-sign patch, Desktop packaging and upload scripts, and Desktop-only client chrome. It supplies no Electron application, no reserved `desktop` profile, and no Desktop-only APIs or stubs. Interactive GUI users launch `dsh web`. Headless, SDK, ACP, the documentation website, and agent tools remain.

The browser Web entry is the only GUI bootstrap: `apps/web` mounts `AppWebEntry` and does not inject Desktop boot facts. Native directory picking uses Host `pickDirectory()` only. Settings connection status remains; Desktop update badges do not. Layout and sidebar no longer apply Darwin hidden-titlebar or Windows caption chrome.

Shared OS-desktop capabilities stay: Host `open-in-app`, native path opening, Linux `.desktop` entries, computer-use, and `workspaceDesktop()`. User Harness home and sessions are not migrated or deleted.

Superseded Desktop implemented notes are archived in this change. Obsolete Desktop update and uninstall proposals are deleted rather than kept as rejected records, because the product they extend is absent. The [sandboxed Sidebar browser](../feature/2026-09-16-sidebar-browser.md) remains the iframe Browser owner; its deferred Electron `<webview>` design is not current behavior.

## Alternatives considered

**Keep Desktop and continue the Electron release train.** This preserves signed installers and a no-system-Node GUI, but retains Electron packaging, notarization, updater policy, and a second Host process. The removal trades that carrier for one interactive entry.

**Replace Electron with a TUI.** A terminal UI is a different product surface. This change does not introduce one.

**Leave Desktop-only APIs as stubs.** Stubs would present a removed carrier as available and keep tests and docs describing it. Absence is the shipped contract.

**Move Desktop to a separate repository.** That would preserve the codebase without shipping it here. This tree deletes the product instead of relocating it.

## Consequences

Existing Desktop installations and `$DSH_HOME/profiles/desktop` receive no migration, updater, or CLI management. Custom compositions that depended on Desktop Host overlays, preload bridges, or Electron window chrome lose those surfaces. Web, Headless, SDK, and ACP continue to share the same session and settings data root.

Reintroducing an Electron or other native GUI requires a new Agent Note, a complete application tree, and evidence that it does not revive Desktop-only client APIs without an owning carrier.

## Verification

The tree contains no `apps/desktop`, `apps/desktop-host`, or workspace `electron` / `electron-builder` dependency. `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, focused hygiene, `pnpm run test:docs`, `pnpm run website:build`, GUI tests, and keyless Headless/SDK/ACP smokes cover the remaining surfaces. Deleted Desktop tests do not evidence the resulting tree.
