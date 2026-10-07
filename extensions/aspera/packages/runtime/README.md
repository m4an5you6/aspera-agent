---
description: "Operate persistent Aspera node/coordinator profiles and restricted planning or execution Agents with generic framework guidance."
kind: "package-bundle"
---

# @aspera/runtime

English | [中文](README.zh.md)

## Summary

Keep experiment control, execution Agents and managed training/inference processes in separate lifetimes. Allocate a node to one experiment, run commands with filesystem/GPU restrictions and retain process cleanup evidence. Prepare plans with read-only tools, then execute approved requirements using a single Agent. Shipped framework skills guide version selection and short verification without framework-specific parameter adapters.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The dispatch provider installs the fixed release, calls `setupWorkerProfile` with a private home and launches the `aspera-worker` profile. Its bundle is [worker.patch.yml](worker.patch.yml) over published DSH base. The [production worker check](../../scripts/test-worker.mjs) exercises this exact entry with no model key; Linux node execution requires the [GPU acceptance](../../docs/verification.md#gpu-acceptance).

Choose `coordinator`, `node`, `planner` or `agent` through role configuration. Deployment fixes the control root, token, release and experiment IDs. [Config](src/index.ts) bounds polling, cleanup, network probe lifetime, file/byte limits and documentation access. [Network probes](src/network-probes.ts) check receiver identities without allocating GPUs; timeout, cancellation and shutdown clean their listeners. The node masks the control directory and other registered experiment roots before binding the current workspace.

Ordinary commands cannot outlive cancellation cleanup. Protocol `4` has no aggregate lifetime or command-count cap; old allocations retain their limits. [Storage preparation](scripts/storage.mjs) checks Linux mounts, capacity, ownership and write access; unknown persistence stays unknown. Profiles and logs live on selected experiment storage, while queue state and credentials remain private. Cache/environment variables use the writable workspace. Registered services retain the full allocation, require live HTTP health and never restart automatically. [Inference gateways](src/inference-gateway.ts) own explicitly mapped public listeners and private service credentials; see [service records and access](../../docs/state-and-api.md#logs-outputs-and-services). `serviceRequestTimeoutMs` (300000) limits upstream idle time and `serviceRequestBytes` (16777216) bounds request bodies; both are node profile settings.

`goalContinuationWindow` is a deployment setting, defaulting to `128` rounds; `DSH_CLUSTER_GOAL_WINDOW` configures it in the worker patch. The continuation plugin extends the same Goal through public `Goal.edit` before its finite window is exhausted. Each extension is logged; it is not a user task budget. Connection, probe and model-operation timeouts, loop guards, confinement and cancellation remain active.

[Owned file cleanup](src/storage.ts) removes only the saved experiment workspace and named private transfer files after dispatch confirms resource release. It checks owner markers, canonical paths and mount identity, rejects nested mounts and never traverses directory links. Shared releases, caches and control state remain; interrupted cleanup resumes from its private quarantine directory. The optional cancellation signal closes the active SSH command without requiring local record deletion to wait for it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[observations.ts](src/observations.ts) owns the independent version-1 source directory and bounded, redacted output records. Installation imports retain remote sequence numbers and collection times and deduplicate repeated pages, including long final records. [metrics.ts](src/metrics.ts) samples measured node resources; reported training values remain a separate series. Coordinator requests to its own pinned node use authenticated loopback; other nodes retain SSH. These reads do not release allocations or restart failed work. See [observation configuration and compatibility](../../docs/state-and-api.md#logs-outputs-and-services).

[phase-model.ts](src/phase-model.ts) mounts the standard DSH Agent driver, a separate LLM service and the selected pinned provider together for each phase, inheriting the profile's driver limits. [phase-agents.ts](src/phase-agents.ts) shares Agent publication and initiator tracking with the profile so Goals, records and cancellation retain their normal ownership. Creation and resume verify the saved configuration digest and private credential; concurrent phases can use different saved settings for the same provider name. Dispose the Agent before its model context. [records.ts](src/records.ts) pages real phase events; node commands write separate stdout/stderr files in addition to the node overview log.

<details>
<summary>Implementation internals</summary>

[transport.ts](src/transport.ts) supports password and key SSH commands with separate stdout/stderr, exit status, timeout/cancellation and confirmed-exit evidence. `remote` retains its successful-stdout interface; `remoteResult` returns nonzero command results for diagnosis. Connection failures remain errors. Verified executable directories apply to every subsequent command. Losing an SSH connection does not establish that the remote process stopped.

[ssh-host-keys.ts](src/ssh-host-keys.ts) supplies local first-use public-key discovery and locked registration for dispatch. Discovery uses the bundled SSH client and disconnects before authentication; it requires no `ssh-keyscan` process and follows the caller's cancellation and deadline. Authenticated transport reads registered keys without enrolling identities; delegated node connections retain their private, preinstalled trust files. Registration stops on cancellation and preserves unrelated entries, hashed hosts and revocations.

[cluster.ts](src/cluster.ts) mounts authenticated control routes and storage lifetimes. [cluster-runtime.ts](src/cluster-runtime.ts) transfers/checks inputs, starts separate Agent profiles and observes services. [cluster-node.ts](src/cluster-node.ts) serializes claims and cleanup evidence. [cluster-agent.ts](src/cluster-agent.ts) installs tools only into the experiment's Agent scope. Private directories remain outside its writable workspace. Admission, command and file paths execute the resource/security checks; no independent service-presence invariant entry is published.

[Node record ownership](../../docs/state-and-api.md#persistent-ownership) defines the shared command key used by execution, logs and service cleanup. Node lifecycle tests use the published JSON backend, reopen durable records after simulated restart and retain unresolved process ownership.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Scheduling provider interface](../experiments/README.md)
- [Data and API versions](../../docs/state-and-api.md)

<a id="model-experience"></a>
## Model Experience

Agents receive logged immutable requirements and the approved plan. Both roles can read shipped guidance, allowlisted HTTPS documentation and declared input bytes. Planning adds plan saving; execution adds confined commands, logs/files, measured progress, version/script/environment/parameter records and registered service management. Completion requires execution evidence, completed step reports and settled successful commands or healthy owned services on every node. Missing requirements produce a persisted blocked Goal.

Execution uses `get_experiment_execution_progress` and `report_experiment_step` to report each approved step as running, completed or blocked. Worker identity and call time come from the program. Revision conflicts return diagnostics and current reports; the Agent repairs the report without rerunning settled commands. Missing step reports keep the Goal active until corrected. These reports never replace independent command, node or result acceptance. [Step persistence](../../docs/state-and-api.md#execution-step-progress) defines ownership and late-message refusal.

Global tools are masked in the Agent scope and plugin-manager layers are disabled. Automatic mode rejects human waiting at the question service, including direct requests; semi mode exposes the existing question service through a persisted remote answerer. Unresolved choices pause new Agent tools while managed node processes remain cancellable. Transient provider errors rearm the same Goal; explicit blockers and unrecoverable failures persist terminal reasons. Replies cannot change submitted requirements or grant permissions. [Megatron](skills/megatron/SKILL.md), [MS-SWIFT](skills/swift/SKILL.md) and [Unsloth](skills/unsloth/SKILL.md) guidance require documented versions, isolated environments, short runs and measured evaluations rather than claiming optimal parameters.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Production execution requires Linux bubblewrap and NVIDIA devices; network access is shared rather than isolated.
- Provider transfer supports DeepSeek and pi-ai key APIs. OAuth grants, cloud identity chains and arbitrary provider plugins require separate integration.
- Ambiguous node restarts require operator reconciliation; no force release or automatic training restart is provided.
- Multi-Agent algorithms and an RSI optimization pipeline are separate extensions.

### Dev Note

None.
