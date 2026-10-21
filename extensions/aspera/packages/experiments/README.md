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

[interruption.ts](src/interruption.ts) defines independent version-1 operation receipts without changing submission, fleet or Session generations. Queue terminal states reject late updates that would resume ended work; release reconciliation preserves an existing terminal result. [Controlled interruption](../../docs/state-and-api.md#experiment-interruption) defines public fields, node evidence and retained history.

[archive.ts](src/archive.ts) exports version-1 local-copy status and source availability, independently of experiment results. [Local running records](../../docs/state-and-api.md#local-running-records) owns persistence acknowledgments and consumers; existing submissions, Session events and execution step files retain their formats.

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

Optional cleanup and recovery fields expose independent version-1 `EnvironmentCleanup` and `EnvironmentRecovery` records. Original receipts and observations without these fields remain readable. Mount IDs in diagnostics describe a single check and never authorize a subsequent operation.

[Managed environment types](src/managed-environment.ts) define independent version-1 manifests, package identities, references, reuse plans, startup evidence and candidate-bound cleanup requests. Storage observations optionally include reuse plans and dated material descriptors; cleanup distinguishes package, material and temporary candidates. Protocol 4, fleet generation 6 and Session formats remain fixed; [environment ownership](../../docs/managed-environments.md#recovery-and-compatibility) defines retained references and consumers.

`EnvironmentRuntime` records an operation's original deadline, stop reason and independent exit/release observations. `EnvironmentRequirements` binds effective merged constraints to the original request hash. `EnvironmentOperationStatus` validates authenticated lightweight reads and final tool results; storage observations optionally include these dated states. Both new persisted records use version 1 without altering prior receipts.

Optional `EnvironmentOperation.failure` contains version-1 `EnvironmentFailure` evidence bound to the experiment, node, environment, request and original conflicting wheel identities. Rejected retries reference the original operation without changing its receipt. `EnvironmentReusePlan.installerTemporaryBytes` optionally records private tooling allocation; prior records without either field remain readable.

Indirect: runtime and dispatch tools render validated records from this library. The library registers no tools or model messages.

Independent [version-1 completion records](src/completion.ts) describe source identities, historical environments and retrospective assessments. Their persistence and compatibility acknowledgement is in [completion verification](../../docs/completion-review.md); original execution entries, protocol 4 and fleet generation 6 remain unchanged.

[Finalization records](src/finalization.ts) and [approved stages](src/stage-requirements.ts) bind numerical checks, command waits, finish decisions and historical step supplements to the original experiment, plan and Session. [Persistence and compatibility](../../docs/finalization.md#records-and-compatibility) acknowledges their independent version-1 files and optional plan fields; original step files and Session formats remain unchanged.

[Storage records](src/storage-governance.ts) declare branded candidate/operation IDs, catalogs, historical loans, per-volume plans, canonical materials, bindings and final-exit receipts. Optional storage-observation fields and selected cleanup IDs retain previous readers' data. Independent version-1 persistence and generated consumer changes are acknowledged in [storage governance](../../docs/storage-governance.md#records-and-compatibility); protocol 4, fleet 6 and Session formats remain unchanged.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- One coordinator owns admission; no automatic coordinator failover or consensus is provided.
- Provider cleanup must establish process exit; an unknown result keeps resources occupied.
- Files are read on demand; metadata listing has a caller-supplied limit.

### Dev Note

None.
