---
kind: upgrade-guide
description: "Aspera fixed releases require uv and expose managed environment tools, independent records and storage APIs."
---

# Aspera managed training environments

English | [中文](guide.zh.md)

## Change

New Aspera releases pin uv, install through scoped tools and mount shared package payloads read-only. Managed execution disables `.local` installation. Manifests, references and receipts use independent version-1 files; the Host saves dated storage observations. Protocol 4, fleet generation 6, Session format and original submissions remain unchanged.

`managed-environment-install-v3` and `installVersion: 3` require matching controllers and exact `pipVersion`. Isolated tooling and recorded package conflicts prevent unchanged reinstall retries. `create` merges direct requirements; `install` replaces them. Verified wheel aliases survive failure. Installation waits for receipt, exit and admission release; lightweight `operation_id` reads retain the original deadline. Consumers read nested `operation`; `operationReconnectTimeoutMs` defaults to 60000.

`managed-environment-reuse-v1` checks verified materials before installation. Resolutions and startup journals survive failure; payloads share links while metadata stays private. Recovery never infers exit from missing legacy records.

`AsperaRemote` adds storage APIs; regenerate consumers. `ExperimentFleet.open` accepts optional `ManagedEnvironmentPolicy` after `agentContext`. Fixed releases remain retained.

## Migration

`storageFormat: "0.1.0"` requires `purpose-storage-0.1.0`; [storage governance](../../../../extensions/aspera/docs/storage-governance.md#records-and-compatibility) defines placement compatibility. Update resources together. Existing tasks retain their release and directories.

`storageVersion: 1` requires `storage-governance-v1`, `historical-environment-borrow-v1` and `managed-materials-v1`. [Storage governance](../../../../extensions/aspera/docs/storage-governance.md) defines budgets, verified loans, retained unique wheels, selected cleanup and pinned materials. Configure `managedEnvironments.governance`; update plan/refresh consumers. Transfers default to two hours and one per server. Independent version-1 records preserve fleet and Session formats. Release old tasks, then copy experiments; retain sealed releases and hardware requirements.

The `managed-environment-cleanup-v1` capability and manifest `cleanupVersion: 1` require mount-aware cleanup before controller reuse. Independent version-1 cleanup and recovery records separate verified publication from ordinary temporary unlink failures. Pending residue stays hidden with its references retained; safety errors and unknown exits remain blocking. Recovery preserves an already confirmed failed receipt and requires another program verification. Existing sealed releases cannot receive this behavior in place; release the old task, then copy the experiment.

1. Update built Host, runtime and Web resources together using the desktop resource updater. Preserve the existing executable and original installed releases. Copy an old experiment only after its resources are released when the new tools are required.
2. Configure local and remote `managedEnvironments` limits. `uvVersion` and `pipVersion` must match the fixed manifest's `asperaEnvironmentTools` versions. Older release launches omit pip settings and cannot reuse a v3 installer. Controller changes require controlled idle repair. Nodes receive policy through `DSH_CLUSTER_ENVIRONMENT_POLICY_JSON`.
3. Agents request actual dependencies and imports in `training`; the installation tool waits internally. After failed or unresolved results, inspect/recover the same operation and reverify. Stop environment users before mutation. Confirm a repeated preparation downloads zero matching package bytes.
4. Use [storage preview and cleanup](../../../../extensions/aspera/docs/managed-environments.md#space-and-cleanup). Local record deletion retains remote references; confirmed remote deletion releases them. Unknown references, active processes and changed preview digests block collection. Existing environments and caches are not rewritten.
5. Validate Linux filesystem regressions, keyless worker replay and Web storage/cleanup cases. Record unavailable server or CUDA checks separately; CPU fixtures cannot establish GPU acceptance.
