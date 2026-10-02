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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[cluster-protocol.ts](src/cluster-protocol.ts) declares parser and persistence fields; [cluster-queue.ts](src/cluster-queue.ts) owns durable state transitions and asynchronous provider lifetimes. [cluster-files.ts](src/cluster-files.ts) confines paths and reads bounded raw bytes. Resource invariants are enforced by these admission/read paths and behavior tests; the library publishes no separate presence-only invariant installer.

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
