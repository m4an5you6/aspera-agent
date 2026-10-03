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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[phase-model.ts](src/phase-model.ts) mounts a separate LLM service and the selected pinned provider for each phase. It verifies the saved configuration digest and private credential before creating an Agent, and disposes the provider after its Agent. [records.ts](src/records.ts) pages real phase events; node commands write separate stdout/stderr files in addition to the node overview log.

<details>
<summary>Implementation internals</summary>

[cluster.ts](src/cluster.ts) mounts authenticated control routes and storage lifetimes. [cluster-runtime.ts](src/cluster-runtime.ts) transfers/checks inputs, starts separate Agent profiles and observes services. [cluster-node.ts](src/cluster-node.ts) serializes claims and cleanup evidence. [cluster-agent.ts](src/cluster-agent.ts) installs tools only into the experiment's Agent scope. Private directories remain outside its writable workspace. Admission, command and file paths execute the resource/security checks; no independent service-presence invariant entry is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Scheduling provider interface](../experiments/README.md)
- [Data and API versions](../../docs/state-and-api.md)

<a id="model-experience"></a>
## Model Experience

Agents receive logged immutable requirements and the approved plan. Both roles can read shipped guidance, allowlisted HTTPS documentation and declared input bytes. Planning adds plan saving; execution adds confined commands, logs/files, measured progress, version/script/environment/parameter records and registered service management. Completion requires execution evidence and settled successful commands or healthy owned services on every node. Missing requirements produce a persisted blocked Goal.

Global tools are masked in the Agent scope and plugin-manager layers are disabled. Automatic mode rejects human waiting at the question service, including direct requests; semi mode exposes the existing question service through a persisted remote answerer. Unresolved choices pause new Agent tools while managed node processes remain cancellable. Transient provider errors rearm the same Goal; explicit blockers and unrecoverable failures persist terminal reasons. Replies cannot change submitted requirements or grant permissions. [Megatron](skills/megatron/SKILL.md), [MS-SWIFT](skills/swift/SKILL.md) and [Unsloth](skills/unsloth/SKILL.md) guidance require documented versions, isolated environments, short runs and measured evaluations rather than claiming optimal parameters.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Production execution requires Linux bubblewrap and NVIDIA devices; network access is shared rather than isolated.
- Provider transfer supports DeepSeek and pi-ai key APIs. OAuth grants, cloud identity chains and arbitrary provider plugins require separate integration.
- Ambiguous node restarts require operator reconciliation; no force release or automatic training restart is provided.
- Multi-Agent algorithms and an RSI optimization pipeline are separate extensions.

### Dev Note

None.
