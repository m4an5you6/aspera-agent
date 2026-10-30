---
kind: upgrade-guide
description: "Aspera fixed releases require uv and expose managed environment tools, independent records and storage APIs."
---

# Aspera managed training environments

English | [中文](guide.zh.md)

## Change

`wheelMetadataRepairVersion: 2`/`managerCacheVersion: 1` require [authenticated metadata repair and cache eviction](../aspera-wheel-metadata/guide.md).

`readonlyConsumerVersion: 2` requires `readonly-source-consumers-v1` and `readonly-source-consumers-v2`: [source checks](../../../../extensions/aspera/docs/storage-governance.md#agent-selected-environment-repair) verify owned child ancestry, retain original-task protection and stable diagnostics.

`materialRecoveryVersion: 1` requires `managed-material-recovery-v1`. Read optional `settlementError`. [Recovery](../../../../extensions/aspera/docs/storage-governance.md#fixed-materials) retains diagnostics/stdout/stderr and settles confirmed exits without downloading. Older controllers require idle maintenance.

`storagePreflightVersion: 2` requires `storage-preflight-v2`. [Preflight](../../../../extensions/aspera/docs/storage-governance.md#storage-preflight) separates verification, budgets and approved retention. `requirementLedgerVersion: 1` requires `storage-requirement-ledger-v1`: dependency trials cannot amend published requirements. Material omissions remain blocking. Regenerate consumers.

`repairVersion: 1` requires `managed-environment-repair-v1`. Agents select [repairs and reference confirmations](../../../../extensions/aspera/docs/storage-governance.md#agent-selected-environment-repair); historical RECORD files stay unchanged.

`reusePrecheckVersion: 1` requires `historical-environment-precheck-v1` for [early checks](../../../../extensions/aspera/docs/storage-governance.md#historical-environments).

`reuseVerificationVersion: 1` requires `storage-reuse-verification-v1` for [bounded source verification](../../../../extensions/aspera/docs/storage-governance.md#automatic-history-reuse). Registered ready manifests precede legacy hints. Explicit selections retain sources; fields expose `value` or `page`.

Protocol 4, fleet 6, Session and submissions stay unchanged. `sandboxVersion: 1`/`sandboxIpcVersion: 1` require `bounded-sandbox-launch-v1`/`short-temporary-paths-v1`; older controls need idle maintenance.

`managed-environment-install-v3` requires matching controllers and exact `pipVersion`. `create` merges requirements; `install` replaces them. Conflicts reject unchanged retries. Wait for receipt, exit and admission release. Read bounded JSON/detail pages; `operationReconnectTimeoutMs` defaults to 60000. `lockReceiptVersion: 1` requires `managed-environment-lock-receipt-v1`; upgrade older controllers when idle for [lock refusal records](../../../../extensions/aspera/packages/runtime/README.md#model-experience).

`managed-environment-reuse-v1` requires [verified materials, retained resolutions and confirmed exits](../../../../extensions/aspera/docs/managed-environments.md).

`canonicalDatasetVersion: 1` requires `canonical-modelscope-dataset-v1` and Host Git; models require Hugging Face manifests. Preparation verifies bounded diagnostic storage/bubblewrap; installation retains model budgets.

## Migration

Retry unsubmitted work with original assignments, inventories and operations. [Preparation](../aspera-preparation/guide.md) covers streamed SSH input and sandbox termination evidence. Reverify handover.

`registrationFormat: "0.1.3"` requires `storage-registration-0.1.3`, `bounded-diagnostics-0.1.3` and `command-admission-0.1.3`. Configure `finalization.diagnostics`; bubblewrap requires `--size`. [Private builds](../../../../extensions/aspera/packages/dispatch/README.md#sandbox-compatibility-repair) use `sandboxNativeBuildTimeoutMs`/`sandboxNativeBuildBytes`. Native indexes/attempts use independent version-1 records. Uncertain launches retain deadlines and fixed releases.

`materialFormat: "0.1.2"` requires `material-source-bindings-0.1.2`. Budgets bind verified receipts through `materialSources`; publications retain sources. Legacy receipts cannot attest another directory. Regenerate Remote types and consumers.

`materialFormat: "0.1.1"` requires `targeted-materials-0.1.1`. Updating resources preserves blocked outcomes without resuming training or replacing active controllers.

Verification needs no full scan or download budget; acquisition requires capacity admission. Budgets exclude omitted materials. [Finish decisions](../../../../extensions/aspera/docs/finalization.md#finish-decisions) require node-operation evidence; unsupported Agent explanations remain unverified.

`storageFormat: "0.1.0"` requires `purpose-storage-0.1.0`; [storage governance](../../../../extensions/aspera/docs/storage-governance.md#records-and-compatibility) defines compatibility.

`storageVersion: 1` requires `storage-governance-v1`, `historical-environment-borrow-v1` and `managed-materials-v1`. Configure `managedEnvironments.governance`; update plan/refresh consumers. Transfers default to two hours and one per server.

`managed-environment-cleanup-v1` requires mount-aware cleanup. Hidden pending residue retains references; safety errors and unknown exits remain blocking. Recovery preserves failed receipts and requires fresh verification.

1. Update desktop Host/runtime/Web. Preserve executable/releases; release old experiments before copying.
2. Configure `managedEnvironments` and fixed uv/pip; `DSH_CLUSTER_ENVIRONMENT_POLICY_JSON` carries policy. Older releases lack pip settings; v3 requires idle repair.
3. Agents select `training` requirements/imports, recover and reverify. Stop users before mutation; reuse matching packages.
4. Use [storage preview/cleanup](../../../../extensions/aspera/docs/managed-environments.md#space-and-cleanup). Confirm remote deletion before releasing references. Unknown references, active processes or changed preview digests block collection.
5. Validate profiles and Linux; report CUDA separately.
