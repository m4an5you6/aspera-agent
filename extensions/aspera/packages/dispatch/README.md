---
description: "Configure servers and dispatch immutable Aspera experiments through shared DSH tools, generated Remotes and fixed releases."
kind: "package-bundle"
---

# @aspera/dispatch

English | [中文](README.zh.md)

## Summary

Submit multiple independent Goals, stage inputs and transfer complete experiment materials before returning remote ownership. Preserve server settings, credentials references and release identity across retries. Share the same task service between the Aspera page and Agent tools. Store the full receipt before completing a matching dispatch Goal.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The [workspace startup](../../README.md#start-the-management-page) creates an `aspera` profile over published DSH base/Web bundles and this package's [cordis.patch.yml](cordis.patch.yml). It mounts the adapter and management page. Built artifacts can be installed without the Harness source checkout; [installed verification](../../scripts/test-installed.mjs) exercises the same profile and public declarations.

`extensionRoot` selects the fixed release, `dataRoots` allows local input files, and phase snapshots identify private model credentials. `minimumFreeBytes` configures the storage reserve (default 1 GiB), captured per experiment. Operation, polling and download settings are validated [Config](src/index.ts) fields; the shipped patch reads `ASPERA_DATA_ROOTS` (the legacy `ASPERA_MODEL_CREDENTIAL_REFS` setting is retained for configuration reads). Connection checks do not call a model or create remote directories.

Servers use password login with a separate username. The first saved server is the fixed coordinator; its address, control port and root cannot be changed while it owns state. Repeated SSH addresses/ports are refused. Ordinary server edits do not change pinned experiments. The node uses its configured control port, and the coordinator uses the following port.

`AsperaRemote` publishes typed unary methods and a reconnectable snapshot stream. `ExperimentFleet` owns identical tool/Web dispatch behavior; `FleetDriver` supplies the complete deployment provider. Input writes are bounded/idempotent, downloads are one-use and effect cleanup joins local work without cancelling remotely accepted tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Model admission resolves the three explicit choices through the DSH provider directory. [models.ts](src/models.ts) stores private API settings and independent credential references; retries load those snapshots. DeepSeek and supported pi-ai key routes use pinned adapters. Legacy `agentCredentialRefs` remains a configuration-read field; generation 4 transfers only credentials referenced by the admitted phase snapshots.

<details>
<summary>Implementation internals</summary>

[fleet.ts](src/fleet.ts) owns registry, preparation, Goal checks and complete receipts. [storage-selection.ts](src/storage-selection.ts) exposes only inventory and candidate-selection tools; [network-selection.ts](src/network-selection.ts) validates peer reachability and joins cleanup. [snapshot.ts](src/snapshot.ts) packages fixed releases; [cluster-deploy.ts](src/cluster-deploy.ts) retains active controls and private credentials. [downloads.ts](src/downloads.ts) aborts disconnected reads. Owned relationships are checked in preparation and runtime operations; no service-presence invariant is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Execution roles](../runtime/README.md)
- [State and API ownership](../../docs/state-and-api.md)

<a id="model-experience"></a>
## Model Experience

Dispatch tools list non-secret servers, submit an explicit server group and read experiment status. Requirements and the full acceptance receipt are persisted in the dispatch Session. The fixed first line **本机派发完成，远端实验已接管** appears only after local receipt persistence; ID/revision comparison prevents completing an edited Goal. Framework execution belongs to the remote runtime rather than the conversation's global tools.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Public server configuration supports passwords only; there is no password/key priority selection.
- Host keys must already be trusted in `known_hosts`; an unknown or changed key fails.
- Released generation-1–3 records remain readable without rewriting hashes; old unfinished preparations use Copy as new experiment.
- Incompatible control upgrades wait for existing tasks and controls to finish.

### Dev Note

None.
