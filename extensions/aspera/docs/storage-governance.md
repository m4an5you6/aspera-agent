# Server storage and fixed materials

English | [中文](storage-governance.zh.md)

## Summary

Aspera's preparation and execution Agents request storage observations, environment reuse and fixed model/data materials through scoped tools. The Host resolves selected servers and original submissions; the node measures, verifies, reserves, installs and downloads. No additional orchestration Agent or Agent-loop modification is involved. Existing environments, models, datasets, results, logs and sealed releases remain retained.

## Table of Contents

- [Account inventory](#account-inventory)
- [Historical environments](#historical-environments)
- [Capacity and cleanup](#capacity-and-cleanup)
- [Fixed model and dataset materials](#fixed-materials)
- [Records and compatibility](#records-and-compatibility)

-----

<a id="account-inventory"></a>
## Account inventory

Preparation's `inspect_server_storage` uses the SSH login account. Execution's `inspect_experiment_storage` uses the same node service. Owned roots come from the saved placement, controller storage-root registry and ownership markers. Capacity observations also include configured local mount prefixes without adopting or recursively scanning unowned directories. Account writability, sandbox writability and hidden historical directories remain separate observations; an unknown value stays unknown.

The catalog distinguishes releases, environments, installation packages, models, datasets, temporary files, checkpoints, results, logs and other owned files. Logical sizes count directory entries; physical allocation counts each device/inode once. Filesystem free space is measured independently. Unattributed usage includes unscanned and unowned data; it is not a cleanup authorization. A bounded scan saves its cursor and original measurement time. The overview reads the saved catalog; Refresh or Continue scan explicitly requests more work. Changed root ownership or volume identity prevents adoption.

`managedEnvironments.governance` configures `scanEntryLimit: 100000`, `scanTimeoutMs: 10000`, `snapshotFileLimit: 200000` and `verificationTimeoutMs: 300000`. Exceeded or unreadable scans remain incomplete. `inventoryMountPrefixes` controls capacity-only discovery. Mount IDs describe the current observation and never grant cross-restart authority.

<a id="historical-environments"></a>
## Historical environments

`prepare_experiment_environment` checks an existing managed `training` environment first. Otherwise it verifies released historical candidates before creating another environment. Optional `reuseCandidateId` selects a program-issued candidate. The source allocation, terminal resource release, command/service release, process state, interpreter, ABI, RECORD contents, links, `.pth` paths, dependencies, requested imports and required CUDA must verify. Metadata directories alone do not establish a usable environment. Incomplete discovery blocks an automatic second installation.

A matching source is bound as a verified historical installation, not as a verified wheel origin. The program atomically retains a source lease before publishing the destination binding. Commands and inference services mount only the environment and required interpreter paths read-only, keep other source-experiment files hidden and use the returned absolute interpreter. User packages and bytecode writes are disabled. Source-file, interpreter-link or volume changes require reverification. Source commands, mutation and remote deletion are refused while a binding remains. Publication and source deletion share the controller admission lock. `make-writable` cannot change a borrowed source.

Borrowing performs no dependency installation or second venv creation. Unsatisfied candidates retain concrete differences. An explicit independent installation uses its own budget and existing managed-generation behavior; it never patches the source. Same-volume verified package stores can contribute linked wheels and package payloads without expansion. Cross-volume cache import is reported separately rather than silently copying all historical packages. Environment and source references survive completion and local-only record deletion; confirmed remote binding deletion releases the consumer reference.

<a id="capacity-and-cleanup"></a>
## Capacity and cleanup

Purpose placement groups capacity by actual filesystem device, so directories and bind mounts share one reserve. `managedEnvironments.governance` adds `systemReserveBytes: 5368709120`, `systemReserveRatio: 0.10`, `dataReserveBytes: 2147483648` and `dataReserveRatio: 0.05`; each disk retains the largest of its absolute, proportional and existing minimum-free margins. `peakSafetyFactor: 1.20` covers additional download, unpack/build, copy and coexistence estimates. `capacityRecheckMs: 5000` bounds lightweight checks during active managed installation without rescanning the catalog.

Optional `environmentEstimate: { peakBytes, basis }` declares a reasoned additional peak, not a verified installed size. `allowEnvironmentFallback: true` first checks historical reuse. If data storage still cannot fit, the program may register an unused training environment on the controller's system filesystem. Every remaining model/data/output volume must fit, and the system target must fit its peak, peer reservations and margin. Existing environment requests, installation receipts or published environments prevent relocation. Unknown estimates remain pending; insufficient targets retain per-volume deficits and the unsuccessful fallback assessment.

The separate environment workspace and package store do not change the submitted data workspace or material identities. Publication, read-only command mounts, historical reuse and confirmed remote deletion verify their ownership and filesystem. Applied fallback produces one official floating Toast with a storage-detail action; its management-profile claim survives navigation, reload and restart. Closing the notice retains placement history.

`assess_experiment_storage` binds a UUID operation, environment requirements, canonical material IDs, output bytes and checkpoint bytes. It calculates each mounted volume independently. Missing materials, remaining environment peak, required independent copies, output/checkpoint growth and the existing minimum-free reserve are checked together. Verified reuse does not count another full installation. Unknown dependency estimates remain pending. Already measured result/checkpoint growth reduces the remaining declared output reserve. A ready deployment reserve alone is not training-capacity acceptance.

Installation, material acquisition and ordinary commands with a declared capacity plan repeat program checks. Server-owned reservations coordinate other experiments; identical physical material content is not reserved twice. Reservations remain after connection loss or uncertain process exit. Confirmed node release removes capacity reservations; retained environment/material references have a separate lifetime. The ordinary shell interface is not a filesystem quota, and shell keyword matching is not used to infer resource needs.

Cleanup preview includes confirmed exited private installation residue, unreferenced managed package objects and duplicate verified wheels with a retained valid copy. Unique verified wheels, environments, model/data content, checkpoints, scripts, results, logs and releases are excluded. Historical candidates require selected candidate IDs and the original preview fingerprint. Cleanup rechecks references, process exit, source identity and store locks. Descriptor-relative deletion and actual mount IDs retain traversal, symbolic-link and nested/bind-mount protection. A partial cleanup keeps its receipt and remaining evidence; ordinary temporary unlink failure does not invalidate a verified environment. Safety or exit uncertainty remains blocking.

<a id="fixed-materials"></a>
## Fixed model and dataset materials

`inspect_experiment_materials` obtains a canonical Hugging Face repository and immutable 40-character revision manifest, including every selected file's size and SHA-256 or Git-blob identity. `files` selects required content. The Host can fetch the same bounded canonical metadata when the node cannot reach it, then submits it through an authenticated program endpoint. Mirror transport is checked against canonical bytes. ModelScope accepting a revision parameter does not attest a Hugging Face commit; a direct provider request without supported immutable attestation remains blocked.

`prepare_experiment_materials` accepts an inspected material ID, ready capacity-plan ID and original operation ID with `acquire`, `verify` or `recover`. Materials use a confirmed data-volume library. Verified historical files may be referenced read-only after source-release checks; importing them does not create a full weight copy. New downloads write private files directly beside their final library location and publish on the same volume after verification. Completed files and verified partial shards survive failure. Ranged downloads validate offsets; all completed bytes must match the canonical identity. A shared file index also reuses identical files across repository revisions, using hard links first, tested copy-on-write next and a recorded fresh space check before an independent copy.

One owner downloads each material identity. Server transfer slots default to one; matching requests reuse durable state. Tools wait for the final receipt, actual exit and admission release. `materialTimeoutMs` defaults to 7200000, `metadataWaitTimeoutMs` to 120000 and `networkReadTimeoutMs` to 30000; polling and reconnection use the existing environment operation settings. Reconnection never resets the original deadline. Cancellation and timeout retain stop reasons and require exit confirmation before recovery. Model-visible diagnostics and results remain in the original Session.

Commands and inference services use the returned local paths through read-only mounts. Registered materials default Hugging Face, Transformers and Datasets to offline loading, avoiding a second framework-managed download. Material bindings and file stamps are rechecked at command launch and completion. Program-recorded hard-link creation permits its expected inode metadata change while unrecorded file changes fail validation.

<a id="records-and-compatibility"></a>
## Records and compatibility

Purpose placement persistence acknowledgement: `storage-arrangement.v1.json` uses `version: 1` and business `formatVersion: "0.1.0"`, binding node/experiment ownership, original and environment workspaces, filesystem evidence and a stable fallback event. Capacity plans add optional format, estimate basis, safety factor, actual capacity/device, new peak, deficit and fallback assessment; observations add optional `arrangement`. Legacy records without these fields remain readable; future business formats use `0.1.x`. Fleet generation 6, remote protocol 4 and original request digests remain unchanged.

Manifest `asperaEnvironmentTools.storageFormat: "0.1.0"` requires `purpose-storage-0.1.0`. Older fixed releases receive only supported policy fields. Storage-capability changes follow controlled idle repair; updating desktop resources does not restart remote experiments. Aspera remains 0.1.1 on DSH 0.2.0-rc.2.

Persistence acknowledgement: [storage schemas](../packages/experiments/src/storage-governance.ts) add independent version-1 catalog, historical environment snapshot/binding/lease, capacity plan/reservation, canonical material/index/reference and operation records. Controller-owned indexes live under `state/storage-governance-v1`; experiment-owned borrowing, plan, binding and operation files stay beside the original run. Material receipts preserve original request identity and deadline; runtime records retain observed stop and exit information. New operation records join the existing local archive. Original environment manifests, failed receipts and sealed releases remain unchanged.

Optional storage observations expose catalog, borrowing summaries, plans, materials and their operations. `experimentStoragePlan(id)` reads saved plans and `refreshExperimentStorage(id, serverId, cursor?)` explicitly advances account-side inventory. Existing storage and cleanup APIs retain their parameters; selected candidate IDs are optional extensions. Consumers update together. Offline views preserve measurement times and connection diagnostics; missing counts are not fabricated. Deletion awaits Host reads before removing local observations and rejects late replies.

Manifest `asperaEnvironmentTools.storageVersion: 1` requires `storage-governance-v1`, `historical-environment-borrow-v1` and `managed-materials-v1` in preparation, controller reuse and handover. Existing protocol-4 experiments retain their fixed implementations. Confirm their resource release, then copy an experiment to use these tools; original hardware requirements, outcomes and directories are not rewritten. Protocol 4, fleet generation 6 and Session format remain unchanged. Connection checks remain read-only, model-free and limited to 20 seconds.

Local synthetic tests establish decision, identity and recovery behavior. Actual Linux mount isolation, existing server usage, historical imports, CUDA and 9B training require their corresponding remote observations; a synthetic success cannot replace them.
