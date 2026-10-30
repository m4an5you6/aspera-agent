---
kind: upgrade-guide
description: "Authenticated wheel metadata repair and explicit manager-cache eviction in Aspera."
---

# Aspera input-wheel repair and cache eviction

English | [中文](guide.zh.md)

## Change

`asperaEnvironmentTools.wheelMetadataRepairVersion: 2` requires `managed-wheel-metadata-v1`/`managed-wheel-metadata-v2`; `managerCacheVersion: 1` requires `managed-manager-cache-v1`. Older controllers require controlled idle maintenance before reuse or handover.

Submitted local wheel URLs need an authenticated input proof. An Agent explicitly selects a repair plan and `repairWheelMetadata: true`; the program creates a separate build only for supported metadata discrepancies. Original inputs and executable payloads remain unchanged. Runtime checks remain mandatory.

Cleanup adds the `manager-cache` candidate kind. Only explicitly selected, idle and unreferenced known caches permit fixed-manager eviction. Stale previews return their real diagnostic in a persistent blocked receipt; refresh the preview and choose a new operation ID.

`inputSharingVersion: 1` requires `managed-input-sharing-v1`. Cleanup/schema consumers accept `input-duplicate`; Agents explicitly select it to compact same-content authenticated input snapshots only after original tasks and resources are durably released. Current writable inputs stay excluded. Original paths, bytes and permission identity remain; independent `input-sharing-v1` receipts retain original timestamps and replacements.

`releaseAssetSharingVersion: 1` requires `managed-release-asset-sharing-v1` and the `release-asset-duplicate` cleanup kind. Explicit selection compacts equal immutable LibreOffice/terminal resources only in inactive sealed releases, retaining all paths and bytes. Selected releases, process users and external aliases remain excluded; version-1 `release-asset-sharing-v1` receipts enter the archive.

## Migration

Update tool/schema and generated Remote consumers. Keep old experiments on their fixed release; release them before creating a new copy. Retain original environments, model/data, results and logs. Independent version-1 input proofs, derivations and cache receipts are archived without changing protocol 4, fleet 6 or Session formats. See [managed environments](../../../../extensions/aspera/docs/managed-environments.md).
