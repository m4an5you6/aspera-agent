---
description: "Versioned Aspera experiment requests, whole-server-group scheduling and bounded log/file access for runtime providers."
kind: "package-library"
---

# @aspera/experiments

English | [中文](README.zh.md)

## Summary

Build a persistent experiment queue that allocates every requested server together, allows disjoint tasks to run concurrently and retains uncertain allocations. Parse immutable requests and complete receipts using the same definitions as the management page and nodes. Read bounded logs and output metadata with generation-aware cursors and confined paths. Process execution is supplied by a separate provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Import `ClusterQueue`, request/record schemas and file helpers from the package root; browser programs import declarations from `@aspera/experiments/types`. Supply an `ExperimentTable` that validates durable reads and a `ClusterExecutor` that owns launch, cancellation and recovery. Call `recover` after opening storage and `close` before releasing it; admission methods resolve after durable publication rather than execution completion.

Earlier queued tasks sharing a server precede later tasks. Waiting for approval does not reserve servers. Whole-group allocation writes one experiment record before process launch; incomplete cleanup retains the full group. Identical submission IDs/content return the current receipt, while changed content fails. See the [queue tests](tests/cluster-queue.spec.ts) for a minimal complete table/provider composition.

Questions and replies are serialized with queue mutations. Persist an open question before pausing, save one validated reply before delivery, and use the original question revision for retries. Cancellation expires open questions; recovery reports interrupted work rather than launching a new Agent. [State and APIs](../../docs/state-and-api.md) defines compatibility and reply identities.

Coordinator maintenance uses the same serialization as admission. `beginMaintenance` requires no waiting, planning, execution or serving tasks and no unconfirmed resources; its operation identity prevents another caller from removing the fence. [controller-protocol.ts](src/controller-protocol.ts) validates GPU observations, process identities and authenticated maintenance requests without changing experiment submissions or Session data.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[execution-progress.ts](src/execution-progress.ts) exports independent version-1 step-report and read/result schemas. Reports bind an experiment, approved plan revision and execution Session; the program supplies call identity and time. [Step progress](../../docs/state-and-api.md#execution-step-progress) owns persistence, revision conflicts and compatibility. Existing queue records and plans retain their format.

Generation 4 freezes the short experiment name and three model configuration summaries while retaining generation-1–3 readers. [records.ts](src/records.ts) defines experiment/phase/Session paging and node/process/stream cursors. The initial plan confirmation keeps resources released; whole-group allocation starts after approval.

<details>
<summary>Implementation internals</summary>

[environment-protocol.ts](src/environment-protocol.ts) defines credential-free program observations and verified executable paths. Connection probes can report an incomplete environment before Node is installed; consumers handle optional disk inventory independently from SSH reachability.

[cluster-protocol.ts](src/cluster-protocol.ts) freezes generation-1–3 readers and defines generation-4 submissions; [storage-protocol.ts](src/storage-protocol.ts) separates preferences, SSH evidence and resolved placements. [cluster-queue.ts](src/cluster-queue.ts) owns durable transitions and provider lifetimes. [cluster-files.ts](src/cluster-files.ts) confines bounded reads. Admission checks experiment/node/release ownership and resource assignments; no separate presence-only invariant is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Node provider](../runtime/README.md)
- [Data and API versions](../../docs/state-and-api.md)

<a id="model-experience"></a>
## Model Experience

Indirect: runtime and dispatch tools render validated records from this library. The library registers no tools or model messages.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- One coordinator owns admission; no automatic coordinator failover or consensus is provided.
- Provider cleanup must establish process exit; an unknown result keeps resources occupied.
- Files are read on demand; metadata listing has a caller-supplied limit.

### Dev Note

None.
