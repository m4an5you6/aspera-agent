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

`extensionRoot` is the installed release or independent build root. `dataRoots` explicitly permits local source inputs; browser attachments are staged separately. `agentCredentialRefs` identifies model secrets to transfer. Operation, polling and download expiry settings are validated [Config](src/index.ts) fields. `ASPERA_DATA_ROOTS` supplies a JSON array and `ASPERA_MODEL_CREDENTIAL_REFS` a comma-separated list in the shipped patch.

Servers use password login with a separate username. The first saved server is the fixed coordinator; its address, control port and root cannot be changed while it owns state. Repeated SSH addresses/ports are refused. Ordinary server edits do not change pinned experiments. The node uses its configured control port, and the coordinator uses the following port.

`AsperaRemote` publishes typed unary methods and a reconnectable snapshot stream. `ExperimentFleet` owns identical tool/Web dispatch behavior; `FleetDriver` supplies the complete deployment provider. Input writes are bounded/idempotent, downloads are one-use and effect cleanup joins local work without cancelling remotely accepted tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[fleet.ts](src/fleet.ts) owns registry records, Goal identity comparisons and receipt publication. [snapshot.ts](src/snapshot.ts) packs built files with frozen published dependencies; [cluster-deploy.ts](src/cluster-deploy.ts) preserves existing controls and private remote login files. [downloads.ts](src/downloads.ts) aborts disconnected reads. [ssh-account.ts](src/ssh-account.ts) resolves account-scoped password references. Runtime resource assertions are performed by the scheduler/node provider; this adapter publishes no service-presence invariant entry.

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
- Released version-1 records remain readable; legacy pending work cannot be resumed by the new release.
- Incompatible control upgrades wait for existing tasks and controls to finish.

### Dev Note

None.
