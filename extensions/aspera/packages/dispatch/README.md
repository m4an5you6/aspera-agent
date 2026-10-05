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

`extensionRoot` selects the fixed release, `dataRoots` allows local input files, and phase snapshots identify private model credentials. `minimumFreeBytes` configures the storage reserve (default 1 GiB); `preparationOutputChars` bounds each command's model-visible stdout and stderr (default 65536). Preparation uses the selected SSH account's existing permissions, without a system-package allowlist. Operation, polling and download settings are validated [Config](src/index.ts) fields. The patch reads `ASPERA_DATA_ROOTS` and retains legacy `ASPERA_MODEL_CREDENTIAL_REFS` reads. Connection checks read remote state without invoking a model or configuring dependencies; they distinguish SSH reachability from missing dependencies and may omit disk inventory.

`connectionCheckTimeoutMs` sets one deadline for the complete connection check, defaulting to 20000 milliseconds. Host-key discovery, environment inspection, disk, GPU and control probes share its cancellation signal. Expiry closes active SSH connections and records a failed check before another check can start; dated successful observations remain available. Preparation and installation retain the separate `toolTimeoutMs` policy. Custom fleet callers pass the check deadline to `ExperimentFleet.open` before the optional driver; drivers must honor probe cancellation and await connection cleanup.

Servers use password login with a separate username. Each create request selects `coordinatorId` from its `serverIds`; the submitted snapshot remains fixed when registrations change. Different coordinators cannot have unfinished experiments on overlapping nodes within one management profile. Same-coordinator requests keep remote queue order; initial approval does not allocate GPUs. Removing an unused server preserves historical snapshots and remote files and removes unreferenced owned credentials. Pending work and unconfirmed cleanup block removal. The node uses its configured control port, and its coordinator uses the following port. See [management state and cleanup](../../docs/state-and-api.md) for record deletion and compatibility.

Local connection checks and preparation automatically register previously unseen host keys in the selected `known_hosts` file, defaulting to `~/.ssh/known_hosts`. Discovery sends no password and runs no remote command; registration uses trust on first use and a cross-process file lock. Existing, revoked or unsupported identities are never overwritten. Password login then verifies the registered key; delegated remote connections require their preinstalled keys. `FleetDriver` providers implement `prepareSshHostKey` and verified `cleanupServerStorage`; the browser and host share removal checks through `@aspera/dispatch/server-usage`.

Retries read requirements from the original release. If both its application and DSH manifests omit `engines`, the recorded Aspera `0.1.1` / DSH `0.2.0-rc.2` / pnpm `11.7.0` combination requires Node `^22.19.0 || >=24.0.0`. The release receipt, dependency declaration and installed DSH version must agree. Unknown combinations or invalid declared requirements stop preparation; the current application's Node range never substitutes for the saved release.

`AsperaRemote` publishes typed unary methods and a reconnectable snapshot stream. `ExperimentFleet` owns identical tool/Web dispatch behavior; `FleetDriver` supplies the complete deployment provider. Input writes are bounded/idempotent, downloads are one-use and effect cleanup joins local work without cancelling remotely accepted tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Read-only observations validate experiment, node and Session ownership before returning complete events, registered logs, attachments or measured samples. Preparation captures full command output before limiting tool results. Notice fingerprints persist per management profile; dismissing a Toast leaves failure and cleanup state intact. [Observation APIs](../../docs/state-and-api.md#logs-outputs-and-services) define cursors and legacy availability. Installation and release transfer verify the fixed published DSH rendering adapters through `@aspera/dispatch/compatibility`.

Model admission resolves the three explicit choices through the DSH provider directory. [models.ts](src/models.ts) stores private API settings and independent credential references; retries load those snapshots. DeepSeek and supported pi-ai key routes use pinned adapters. Legacy `agentCredentialRefs` remains a configuration-read field; generation 4 transfers only credentials referenced by the admitted phase snapshots.

<details>
<summary>Implementation internals</summary>

[fleet.ts](src/fleet.ts) owns registry, preparation, Goal checks and receipts. [environment-preparation.ts](src/environment-preparation.ts) adds scoped SSH inspection, commands, verification and blocker reporting to the existing standard DSH Agent. [environment.ts](src/environment.ts) checks observed programs against release requirements before Node-dependent inventory. [storage-selection.ts](src/storage-selection.ts) owns candidate selection; [network-selection.ts](src/network-selection.ts) validates reachability and joins cleanup. [snapshot.ts](src/snapshot.ts) packages releases; [cluster-deploy.ts](src/cluster-deploy.ts) verifies original releases and retains active controls. Preparation serializes each server and persists pending command ownership before execution. Owned relationships are checked by operations; no service-presence invariant is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Execution roles](../runtime/README.md)
- [State and API ownership](../../docs/state-and-api.md)

<a id="model-experience"></a>
## Model Experience

Dispatch tools list non-secret servers, submit an explicit server group and read experiment status. The selected preparation model repairs failed checks through logged tools in the same Session; SSH credentials stay outside model input. Nonzero commands return diagnostics, while unconfirmed exits block repeated mutations. Agent text cannot replace workspace-write, isolation, credential-hiding, GPU and network verification. Passed checks enter the Agent inbox without waking the model; the loop admits their context after its initial system message. Requirements and receipts use existing Session events. **本机派发完成，远端实验已接管** appears only after receipt persistence; ID/revision comparison prevents completing an edited Goal.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Public server configuration supports passwords only; there is no password/key priority selection.
- Host keys must already be trusted in `known_hosts`; an unknown or changed key fails.
- Released generation-1–3 records remain readable without rewriting hashes; old unfinished preparations use Copy as new experiment.
- Incompatible control upgrades wait for existing tasks and controls to finish.

### Dev Note

None.
