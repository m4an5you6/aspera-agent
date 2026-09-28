---
description: "Durable multi-server experiment scheduling and allocation-scoped remote execution."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experiment-worker

English | [中文](README.zh.md)

## Summary

The experiment-worker profile runs coordinator, node and experiment Agent roles as separate processes. The coordinator persists a FIFO queue and allocates complete server groups. Nodes own confined managed commands. Each admitted experiment uses an immutable source release and its own Session, Goal and directories; a queued receipt transfers ownership before execution begins.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The dispatcher launches every role through dsh --profile experiment-worker. Control routes listen on loopback and require private Bearer tokens; SSH provides transport. Linux nodes require usable NVIDIA devices, bubblewrap and the supported subprocess provider. The remote root, credentials, runtime limits and granted devices come from validated deployment configuration.

Disjoint server groups run concurrently. Each server runs one experiment at a time, in the coordinator’s admission order. A waiting task holds no partial allocation; all requested servers must become available together. No node is dropped to make a task runnable. Missing training addresses or failed all-pairs connectivity stop multi-node startup with a recorded error.

The Agent prepares dependencies, data and a coordinated training program using only assigned-node tools. Node commands run in their experiment workspace with granted GPU devices; credentials, control state and other experiment workspaces are masked. Inputs are content-checked before admission and again before execution. Human questions, approvals and plugin installation are disabled.

Cancellation terminates managed commands on every selected node. A terminal result releases the group only when all nodes and the execution Agent confirm cleanup. Restart recovers queued tasks and reconciles prior allocations; ambiguous training is marked interrupted and never automatically replayed. Unconfirmed process cleanup keeps resources occupied for operator verification.

Protocol 2 exposes admission, status, cancellation, per-source event/log cursors and confined artifact reads. Queued receipts may omit execution Session and Goal IDs; running records add them. Log cursors count bytes and include file identity, reset and end markers. File responses list node, relative path, size and modification time; content is read only on request.

The receiver role retains protocol 1 and its historical records until its active experiment finishes. Its idle-shutdown operation refuses while work is active.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

One durable record reserves an entire group before any node allocation. Idempotency hashes bind the experiment ID to its full submission. Private admission verifies releases, staged data and delegated credentials before recording ownership. Each node persists allocation and command identities before spawning, so a retry cannot start the same command twice.

Agent completion flushes the Session and checks real settled command results on every selected node. The coordinator keeps separate execution cleanup evidence. An Agent observes coordinator generation changes and stops after a coordinator restart; missing cleanup evidence remains conservative even if the Agent has exited.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [dispatcher](../experiment-dispatch/README.md) for Web operation and private credential transfer.

<a id="model-experience"></a>
## Model Experience

### Joint execution instructions

#### What the model sees

The logged initial message specifies the objective, stable node ranks, addresses, GPU inventory, inputs and allowed workspace. It requires one distributed run, verified collective communication, actual exit results and output reporting before `Goal` completion.

#### Token effect

Each Session carries its own requirements, tools, node logs and command results. Incremental reads bound individual tool output.

#### KV Cache effect

The initial requirements remain stable within one experiment; variable command evidence appends to that Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A restarted node with an unconfirmed process range retains its allocation for operator inspection.

- The file sandbox constrains files and GPU devices; it does not provide complete network isolation.

- Coordinator failover and automatic training replay are unavailable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Implementation details — click to expand</summary>

No invariant companion duplicates the queue: its record is the allocation authority. Node cleanup evidence is explicitly reconciled before releasing resources.

</details>
