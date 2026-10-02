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

Choose `coordinator`, `node`, `planner` or `agent` through role configuration. The root, token path, release and experiment identities are supplied by deployment. Config fields bound polling, cleanup, file count, byte chunks and HTTPS documentation hosts/size; [Config](src/index.ts) and the patch own accepted values/defaults. Configure node devices, confinement backend and hidden paths before launching its resident profile.

Ordinary commands cannot outlive cancellation cleanup. Protocol `2` commands and services have no aggregate lifetime or command-count cap; legacy allocations retain their published limits. Registered services use independent process identities, retain the complete experiment allocation and survive execution-Agent completion. An occupied port is refused; success requires the managed process to remain alive and its HTTP endpoint to report health. Service observation never relaunches a failed process.

`goalContinuationWindow` is a deployment setting, defaulting to `128` rounds; `DSH_CLUSTER_GOAL_WINDOW` configures it in the worker patch. The continuation plugin extends the same Goal through public `Goal.edit` before its finite window is exhausted. Each extension is logged; it is not a user task budget. Connection, probe and model-operation timeouts, loop guards, confinement and cancellation remain active.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

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
- Worker provider configuration must exist in the pinned profile; selecting a model does not transfer arbitrary provider plugins or settings.
- Ambiguous node restarts require operator reconciliation; no force release or automatic training restart is provided.
- Multi-Agent algorithms and an RSI optimization pipeline are separate extensions.

### Dev Note

None.
